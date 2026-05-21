import "dotenv/config";
import { pool } from "../packages/db/src/client";

async function main() {
  const result = await pool.query("SELECT NOW()");
  console.log("DB Connected:", result.rows[0]);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});