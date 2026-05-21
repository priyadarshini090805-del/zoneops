// Database client. Single source of truth for the pg Pool + Drizzle instance.
// Importing app code should call createDb() once and pass the result around;
// don't call it per-request.
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  pool: pg.Pool;
  db: Db;
}

export function createDb(databaseUrl: string): DbHandle {
  // Why these pool settings:
  // - max:10 is fine for the API and worker each. We'll tune per-service later.
  // - idleTimeoutMillis:30s avoids holding sockets through quiet periods.
  // - connectionTimeoutMillis:5s fails fast on misconfig / cold starts.
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on("error", (err) => {
    // Don't crash; pg will recreate the connection on next checkout.
    // Log at the calling site.
    console.error("[db] idle client error", err);
  });
  const db = drizzle(pool, { schema });
  return { pool, db };
}

export { schema };
