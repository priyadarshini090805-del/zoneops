// Decorates `app.redis` (ioredis client). One shared client per process — fine
// for the API. The worker has its own client(s) for stream consumption.
import fp from "fastify-plugin";
import { Redis } from "ioredis";

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis;
  }
}

export default fp<{ redisUrl: string }>(async (app, opts) => {
  const client = new Redis(opts.redisUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });
  client.on("error", (err: Error) => app.log.error({ err }, "redis client error"));
  app.decorate("redis", client);
  app.addHook("onClose", async () => {
    client.disconnect();
  });
});
