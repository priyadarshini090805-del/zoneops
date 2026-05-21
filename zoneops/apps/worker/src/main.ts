// Worker entrypoint. Boots the consumer(s), ensures DB partitions, handles
// graceful shutdown. Right now we only run one consumer (location_ingress);
// add more here as the rule engine grows.
import pino from "pino";
import { Redis } from "ioredis";
import { sql } from "drizzle-orm";
import { loadWorkerEnv } from "@zoneops/config";
import { createDb } from "@zoneops/db";
import { runLocationIngress } from "./consumers/location-ingress.js";

async function main() {
  const env = loadWorkerEnv();
  const log = pino({
    level: env.LOG_LEVEL,
    transport: env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l" } }
      : undefined,
  });
  log.info({ env: env.NODE_ENV }, "worker booting");

  const dbHandle = createDb(env.DATABASE_URL);
  // Two redis clients: one for stream consumption (blocking), one for ad-hoc writes/publishes.
  const stream = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const pub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });

  // Ensure partitions exist for this month and the next two. Cheap, idempotent.
  await dbHandle.db.execute(sql`SELECT ensure_asset_locations_partition(now()::date)`);
  await dbHandle.db.execute(sql`SELECT ensure_asset_locations_partition((now() + INTERVAL '1 month')::date)`);
  await dbHandle.db.execute(sql`SELECT ensure_asset_locations_partition((now() + INTERVAL '2 months')::date)`);

  // Re-run once a day so we never wake up to a partition-not-found error.
  setInterval(() => {
    dbHandle.db.execute(
      sql`SELECT ensure_asset_locations_partition((now() + INTERVAL '2 months')::date)`,
    ).catch((err) => log.error({ err }, "partition maintenance failed"));
  }, 24 * 60 * 60 * 1000).unref();

  const abort = new AbortController();
  const consumer = runLocationIngress({
    db: dbHandle,
    stream,
    pub,
    log,
    env,
    signal: abort.signal,
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, async () => {
      log.info({ sig }, "shutting down");
      abort.abort();
      await consumer.catch(() => undefined);
      stream.disconnect();
      pub.disconnect();
      await dbHandle.pool.end();
      process.exit(0);
    });
  }

  await consumer;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[worker] fatal boot error", err);
  process.exit(1);
});
