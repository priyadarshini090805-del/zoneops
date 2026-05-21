import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path: path.resolve(__dirname, "../../../.env"),
});

console.log("DATABASE_URL =", process.env.DATABASE_URL);

import Fastify from "fastify";
import { ingestRoutes } from "./routes/ingest";

const app = Fastify({
  logger: true,
});

app.register(ingestRoutes);

app.get("/", async () => {
  return {
    ok: true,
  };
});

app.listen({
  port: 4000,
});