// Fence-membership reconciliation.
//
// For one (asset, position):
//   1. Query PostGIS for which fences currently contain the point  (set A).
//   2. Read previous membership from Redis set                     (set B).
//   3. Diff: entered = A − B, exited = B − A.
//   4. Update Redis set + asset_fence_membership Postgres rows.
//   5. Write fence_events rows for entries (MVP scope = enters only).
//
// MVP simplifications, called out so we remember to fix them:
// - No debounce / hysteresis on edge bouncing. A point on the boundary may
//   ping-pong. Will add a min-dwell timer once we see it in real data.
// - PostGIS query scans active geofences per org. That's fine for MVP-volume
//   tenants (< a few thousand fences). H3 pre-filter goes in Phase 1.
// - We don't reconcile on geofence deletes here; the API publishes a
//   geofences:changed message and a future job rebuilds memberships.
import type { Redis } from "ioredis";
import { sql } from "drizzle-orm";
import { fenceMembershipKey } from "@zoneops/types";
import type { DbHandle } from "@zoneops/db";

export interface ReconcileArgs {
  db: DbHandle;
  pub: Redis;
  orgId: string;
  assetId: string;
  lat: number;
  lon: number;
  observedAt: string; // ISO timestamp
}

export interface ReconcileResult {
  entered: string[];
  exited: string[];
}

export async function reconcileFenceMembership(args: ReconcileArgs): Promise<ReconcileResult> {
  const { db, pub, orgId, assetId, lat, lon, observedAt } = args;

  // 1) Which fences contain this point right now?
  const result = await db.db.execute<{ id: string }>(sql`
    SELECT id
    FROM geofences
    WHERE org_id = ${orgId}::uuid
      AND active
      AND ST_Covers(geometry, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography)
  `);
  const currentFences = new Set<string>(
    (result as unknown as { rows: { id: string }[] }).rows.map((r) => r.id),
  );

  // 2) Previous membership from Redis. smembers() returns string[] at runtime;
  //    cast keeps strict TS happy across ioredis type variants.
  const key = fenceMembershipKey(assetId);
  const previousList = (await pub.smembers(key)) as string[];
  const previousFences = new Set<string>(previousList);

  // 3) Diff.
  const entered: string[] = [...currentFences].filter((id) => !previousFences.has(id));
  const exited: string[] = [...previousFences].filter((id) => !currentFences.has(id));

  // 4) Update Redis set (one round-trip via pipeline).
  if (entered.length > 0 || exited.length > 0) {
    const pipe = pub.pipeline();
    if (entered.length > 0) pipe.sadd(key, ...entered);
    if (exited.length > 0) pipe.srem(key, ...exited);
    // Modest TTL on the membership set as a safety net against stale state
    // after a crash; the next ingest refreshes it.
    pipe.expire(key, 60 * 60 * 24);
    await pipe.exec();
  }

  // 5) Update Postgres membership table + write fence_events.
  if (entered.length > 0) {
    await db.db.execute(sql`
      INSERT INTO asset_fence_membership (org_id, asset_id, geofence_id, entered_at, last_seen_at)
      SELECT ${orgId}::uuid, ${assetId}::uuid, x.id::uuid, ${observedAt}::timestamptz, ${observedAt}::timestamptz
      FROM unnest(${entered}::text[]) AS x(id)
      ON CONFLICT (asset_id, geofence_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
    `);
    await db.db.execute(sql`
      INSERT INTO fence_events (org_id, asset_id, geofence_id, event_type, at)
      SELECT ${orgId}::uuid, ${assetId}::uuid, x.id::uuid, 'enter', ${observedAt}::timestamptz
      FROM unnest(${entered}::text[]) AS x(id)
    `);
  }

  if (exited.length > 0) {
    await db.db.execute(sql`
      DELETE FROM asset_fence_membership
      WHERE asset_id = ${assetId}::uuid
        AND geofence_id = ANY(${exited}::uuid[])
    `);
    // Exit events are written but not yet surfaced in the UI. Free at this point.
    await db.db.execute(sql`
      INSERT INTO fence_events (org_id, asset_id, geofence_id, event_type, at)
      SELECT ${orgId}::uuid, ${assetId}::uuid, x.id::uuid, 'exit', ${observedAt}::timestamptz
      FROM unnest(${exited}::text[]) AS x(id)
    `);
  }

  // Update last_seen_at for assets still inside the same fences (dwell heartbeat).
  if (currentFences.size > 0 && entered.length === 0) {
    await db.db.execute(sql`
      UPDATE asset_fence_membership
      SET last_seen_at = ${observedAt}::timestamptz
      WHERE asset_id = ${assetId}::uuid
    `);
  }

  return { entered, exited };
}
