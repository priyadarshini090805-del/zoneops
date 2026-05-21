import "dotenv/config";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { db, pool } from "./client";

async function main() {
  console.log("Running migrations...");

  await migrate(db, {
    migrationsFolder: "./packages/db/migrations",
  });

  console.log("Migrations complete");

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});