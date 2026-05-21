// location_ingress consumer.
//
// Loop:
//   1. XREADGROUP (block until messages or timeout)
//   2. For each message: insert into asset_locations (history), reconcile
//      fence membership, emit fence_event rows for entries (MVP-1 = enters only),
//      publish live updates onto the per-org Pub/Sub channel.
//   3. XACK on success.
//
// Failure handling: per-message try/catch. Failed messages are XACK'd anyway
// so they don't pin the consumer group; they're logged at error level. We'll
// add a real DLQ + pending-list reclaim once we've seen real failure modes.
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { sql } from "drizzle-orm";
import {
  StreamLocationIngress,
  Streams,
  liveChannel,
  type FenceEvent,
} from "@zoneops/types";
import type { DbHandle } from "@zoneops/db";
import type { WorkerEnv } from "@zoneops/config";
import { reconcileFenceMembership } from "../spatial/fence-membership.js";

interface RunArgs {
  db: DbHandle;
  stream: Redis;
  pub: Redis;
  log: Logger;
  env: WorkerEnv;
  signal: AbortSignal;
}

export async function runLocationIngress(args: RunArgs): Promise<void> {
  const { db, stream, pub, log, env, signal } = args;
  const streamKey = Streams.locationIngress;
  const group = env.WORKER_CONSUMER_GROUP;
  const consumer = env.WORKER_CONSUMER_NAME;

  // MKSTREAM lets us create the consumer group even before any producer has
  // written to the stream. BUSYGROUP error on re-run is expected & ignored.
  try {
    await stream.xgroup("CREATE", streamKey, group, "$", "MKSTREAM");
  } catch (err: unknown) {
    const msg = (err as Error).message ?? "";
    if (!msg.includes("BUSYGROUP")) throw err;
  }
  log.info({ stream: streamKey, group, consumer }, "consumer ready");

  while (!signal.aborted) {
    // ioredis types for xreadgroup are loose; the result shape is well-defined.
    const result = (await stream.xreadgroup(
      "GROUP", group, consumer,
      "COUNT", env.WORKER_BATCH_SIZE,
      "BLOCK", env.WORKER_BLOCK_MS,
      "STREAMS", streamKey, ">",
    )) as Array<[string, Array<[string, string[]]>]> | null;

    if (!result || result.length === 0) continue;

    for (const [, messages] of result) {
      for (const [id, fields] of messages) {
        try {
          await handleMessage({ db, pub, log, fields });
          await stream.xack(streamKey, group, id);
        } catch (err) {
          log.error({ err, id }, "message processing failed");
          // Ack anyway for MVP. Add pending-list reclaim once failure modes are real.
          await stream.xack(streamKey, group, id);
        }
      }
    }
  }
}

async function handleMessage(args: {
  db: DbHandle;
  pub: Redis;
  log: Logger;
  fields: string[];
}): Promise<void> {
  const { db, pub, log, fields } = args;
  // ioredis returns alternating field/value pairs.
  const payloadIdx = fields.indexOf("payload");
  if (payloadIdx < 0 || payloadIdx + 1 >= fields.length) {
    log.warn({ fields }, "stream message missing payload");
    return;
  }
  const raw = fields[payloadIdx + 1]!;
  const msg = StreamLocationIngress.parse(JSON.parse(raw));

  // 1) Append to historical breadcrumb table.
  await db.db.execute(sql`
    INSERT INTO asset_locations
      (org_id, asset_id, position, heading_deg, speed_mps, observed_at, source)
    VALUES (
      ${msg.org_id}::uuid,
      ${msg.asset_id}::uuid,
      ST_SetSRID(ST_MakePoint(${msg.lon}, ${msg.lat}), 4326)::geography,
      ${msg.heading_deg ?? null},
      ${msg.speed_mps ?? null},
      ${msg.observed_at}::timestamptz,
      ${"ingest"}
    )
  `);

  // 2) Reconcile fence membership and emit enter events.
  const { entered } = await reconcileFenceMembership({
    db, pub,
    orgId: msg.org_id,
    assetId: msg.asset_id,
    lat: msg.lat,
    lon: msg.lon,
    observedAt: msg.observed_at,
  });

  // 3) Live-map update. Publish a compact JSON message; SSE forwards it.
  await pub.publish(liveChannel(msg.org_id), JSON.stringify({
    event: "location_update",
    asset_id: msg.asset_id,
    lat: msg.lat,
    lon: msg.lon,
    observed_at: msg.observed_at,
  }));

  // 4) For each new fence_enter, publish to the live channel too so the UI
  //    can show a toast / highlight without polling.
  for (const fenceId of entered) {
    const evt: FenceEvent = {
      type: "enter",
      org_id: msg.org_id,
      asset_id: msg.asset_id,
      geofence_id: fenceId,
      at: msg.observed_at,
    };
    // `evt.type` carries the fence event kind ("enter"); the outer envelope
    // uses `event` so SSE clients can route on a single field.
    await pub.publish(liveChannel(msg.org_id), JSON.stringify({
      event: "fence_event",
      ...evt,
    }));
  }
}
