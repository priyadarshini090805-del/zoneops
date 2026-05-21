import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://zoneops:zoneops@localhost:5432/zoneops";

console.log("DB CONNECTION =", connectionString);

const pool = new Pool({
  connectionString,
});

export const db = drizzle(pool);

export { pool };