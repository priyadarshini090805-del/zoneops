// 30-line migrator. Reads packages/db/migrations/*.sql, runs each in a tx,
// records executed migrations in _migrations. Designed to be re-runnable.
//
// We use raw SQL files (not drizzle-kit generate) because PostGIS columns,
// GIST indexes, partial indexes, and partitioning don't round-trip cleanly
// through introspection. The whole migrator fits in your head.
import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../migrations");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const { rows: applied } = await client.query<{ name: string }>(
      "SELECT name FROM _migrations ORDER BY name",
    );
    const appliedSet = new Set(applied.map((r) => r.name));

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort(); // lexicographic = numeric thanks to the 0000_ prefix

    let ran = 0;
    for (const file of files) {
      if (appliedSet.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      const start = Date.now();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`[migrate] applied ${file} in ${Date.now() - start}ms`);
        ran++;
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`[migrate] failed ${file}:`, err);
        throw err;
      }
    }
    if (ran === 0) {
      console.log("[migrate] nothing to do (all migrations already applied)");
    } else {
      console.log(`[migrate] done — ${ran} migration(s) applied`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
