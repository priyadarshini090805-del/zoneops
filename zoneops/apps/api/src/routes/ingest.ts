// POST /v1/ingest/locations — the hot ingestion path.
//
// Tradeoff notes:
// - We UPSERT into assets_latest synchronously so the live map can read
//   current state without scanning the stream. Two writes per point on the
//   hot path is fine at MVP volumes; revisit if pg CPU climbs.
// - We DO NOT write asset_locations (history) from the API. The worker does
//   that after consuming the stream. Keeps this endpoint single-purpose.
// - Unknown external_asset_ids are auto-provisioned as kind=vehicle. This
//   gets us to "trucks moving on a map" faster than forcing pre-registration;
//   tighten before first paid customer.
import type { FastifyPluginAsync } from "fastify";
import { sql } from "drizzle-orm";
import { IngestLocationsBody, Streams, type StreamLocationIngress } from "@zoneops/types";

const ingest: FastifyPluginAsync = async (app) => {
  app.post("/locations", async (req, reply) => {
    const auth = await app.requireAuth(req);
    const body = IngestLocationsBody.parse(req.body);

    // Resolve external_asset_id -> asset_id (auto-provision if missing).
    const externalIds = [...new Set(body.points.map((p) => p.external_asset_id))];
    const lookup = await app.db.db.execute<{ id: string; external_id: string }>(
      sql`SELECT id, external_id FROM assets
          WHERE org_id = ${auth.orgId} AND external_id = ANY(${externalIds})`,
    );
    const byExternal = new Map<string, string>();
    for (const row of (lookup as unknown as { rows: { id: string; external_id: string }[] }).rows) {
      byExternal.set(row.external_id, row.id);
    }
    // Auto-provision the missing ones in one statement using unnest for safe binding.
    const missing = externalIds.filter((eid) => !byExternal.has(eid));
    if (missing.length > 0) {
      const inserted = await app.db.db.execute<{ id: string; external_id: string }>(sql`
        INSERT INTO assets (org_id, external_id, kind, label)
        SELECT ${auth.orgId}::uuid, eid, 'vehicle', 'auto:' || eid
        FROM unnest(${missing}::text[]) AS t(eid)
        RETURNING id, external_id
      `);
      for (const row of (inserted as unknown as { rows: { id: string; external_id: string }[] }).rows) {
        byExternal.set(row.external_id, row.id);
      }
    }

    const accepted: string[] = [];
    const streamMessages: StreamLocationIngress[] = [];
    const upserts: Array<{
      assetId: string; lat: number; lon: number;
      heading: number | null; speed: number | null; at: string;
    }> = [];

    for (const p of body.points) {
      const assetId = byExternal.get(p.external_asset_id);
      if (!assetId) continue;
      accepted.push(p.external_asset_id);
      upserts.push({
        assetId, lat: p.lat, lon: p.lon,
        heading: p.heading_deg ?? null,
        speed: p.speed_mps ?? null,
        at: p.observed_at,
      });
      streamMessages.push({
        org_id: auth.orgId,
        asset_id: assetId,
        lat: p.lat,
        lon: p.lon,
        heading_deg: p.heading_deg,
        speed_mps: p.speed_mps,
        observed_at: p.observed_at,
      });
    }

    // Bulk upsert into assets_latest. WHERE clause prevents older fixes
    // bouncing newer ones (out-of-order fleet webhooks are routine).
    if (upserts.length > 0) {
      await app.db.db.transaction(async (tx) => {
        for (const u of upserts) {
          await tx.execute(sql`
            INSERT INTO assets_latest (asset_id, org_id, position, heading_deg, speed_mps, observed_at)
            VALUES (
              ${u.assetId}::uuid,
              ${auth.orgId}::uuid,
              ST_SetSRID(ST_MakePoint(${u.lon}, ${u.lat}), 4326)::geography,
              ${u.heading},
              ${u.speed},
              ${u.at}::timestamptz
            )
            ON CONFLICT (asset_id) DO UPDATE SET
              position    = EXCLUDED.position,
              heading_deg = EXCLUDED.heading_deg,
              speed_mps   = EXCLUDED.speed_mps,
              observed_at = EXCLUDED.observed_at,
              received_at = now()
            WHERE EXCLUDED.observed_at >= assets_latest.observed_at
          `);
        }
      });
    }

    // Fan-out to Redis stream in one pipelined round-trip.
    if (streamMessages.length > 0) {
      const pipe = app.redis.pipeline();
      for (const m of streamMessages) {
        pipe.xadd(Streams.locationIngress, "*", "payload", JSON.stringify(m));
      }
      await pipe.exec();
    }

    return reply.code(202).send({
      accepted: accepted.length,
      rejected: [],
    });
  });
};

export default ingest;
