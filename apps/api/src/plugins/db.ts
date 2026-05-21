// Decorates the Fastify instance with `app.db` (the DbHandle from @zoneops/db).
// We keep the raw pool around so spatial routes can use sql template literals.
import fp from "fastify-plugin";
import { createDb, type DbHandle } from "@zoneops/db";

declare module "fastify" {
  interface FastifyInstance {
    db: DbHandle;
  }
}

export default fp<{ databaseUrl: string }>(async (app, opts) => {
  const handle = createDb(opts.databaseUrl);
  app.decorate("db", handle);
  app.addHook("onClose", async () => {
    await handle.pool.end();
  });
});
