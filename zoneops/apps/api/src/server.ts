// API entrypoint. Boots Fastify, registers plugins, mounts routes.
// Keep this file boring — feature logic lives in routes/.
import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { loadApiEnv, parseApiTokens } from "@zoneops/config";
import dbPlugin from "./plugins/db.js";
import redisPlugin from "./plugins/redis.js";
import authPlugin from "./plugins/auth.js";
import errorPlugin from "./plugins/errors.js";
import ingestRoutes from "./routes/ingest.js";
import assetsRoutes from "./routes/assets.js";
import geofenceRoutes from "./routes/geofences.js";
import streamRoutes from "./routes/stream.js";

async function main() {
  const env = loadApiEnv();
  const tokens = parseApiTokens(env.API_TOKENS);

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Pretty-print only in dev. In prod, ship structured JSON to whoever ingests it.
      transport: env.NODE_ENV === "development"
        ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l" } }
        : undefined,
    },
    // We do strict zod validation in route handlers; turn off the default
    // ajv-based schema validation to avoid duplicate work.
    ajv: { customOptions: { strict: false } },
    bodyLimit: 2 * 1024 * 1024, // 2 MB — ingest batches of 500 points fit comfortably
    trustProxy: true,
  });

  await app.register(sensible);
  await app.register(cors, {
    origin: env.NODE_ENV === "development" ? true : false,
    credentials: true,
  });
  await app.register(errorPlugin);
  await app.register(dbPlugin, { databaseUrl: env.DATABASE_URL });
  await app.register(redisPlugin, { redisUrl: env.REDIS_URL });
  await app.register(authPlugin, { tokens });

  // Health checks. Liveness is dumb on purpose; readiness pings dependencies.
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await app.db.pool.query("SELECT 1");
      const pong = await app.redis.ping();
      return { ok: true, pg: "ok", redis: pong };
    } catch (err) {
      app.log.error({ err }, "readiness check failed");
      return reply.code(503).send({ ok: false });
    }
  });

  await app.register(ingestRoutes, { prefix: "/v1/ingest" });
  await app.register(assetsRoutes, { prefix: "/v1/assets" });
  await app.register(geofenceRoutes, { prefix: "/v1/geofences" });
  await app.register(streamRoutes, { prefix: "/v1/stream" });

  await app.listen({ port: env.API_PORT, host: env.API_HOST });

  // Graceful shutdown — drain in-flight requests then close pools.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, async () => {
      app.log.info({ sig }, "shutting down");
      await app.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[api] fatal boot error", err);
  process.exit(1);
});
