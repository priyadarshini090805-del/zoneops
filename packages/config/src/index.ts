// Centralized environment loading. Every app calls loadEnv() once at boot.
// Why: zod validation up front means a misconfigured deploy fails on boot,
// not 20 minutes later on the first ingest call.
import "dotenv/config";
import { z } from "zod";

// Shared schema. Apps can layer additional fields on top via .extend().
const BaseEnv = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
});

export const ApiEnv = BaseEnv.extend({
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default("0.0.0.0"),
  // Format: "token1=org_slug,token2=org_slug". Parsed below into a Map.
  API_TOKENS: z.string().default(""),
});

export const WorkerEnv = BaseEnv.extend({
  WORKER_CONSUMER_GROUP: z.string().default("zoneops-workers"),
  WORKER_CONSUMER_NAME: z.string().default("worker-1"),
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(200),
  WORKER_BLOCK_MS: z.coerce.number().int().positive().default(2000),
});

export type ApiEnv = z.infer<typeof ApiEnv>;
export type WorkerEnv = z.infer<typeof WorkerEnv>;

export function loadApiEnv(): ApiEnv {
  return ApiEnv.parse(process.env);
}

export function loadWorkerEnv(): WorkerEnv {
  return WorkerEnv.parse(process.env);
}

/**
 * Parse the API_TOKENS env string into a token->org_slug map.
 * Throws if the format is malformed so bad deploys fail loudly at boot.
 */
export function parseApiTokens(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw.trim()) return map;
  for (const pair of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [token, slug] = pair.split("=");
    if (!token || !slug) {
      throw new Error(`API_TOKENS malformed near "${pair}" — expected token=org_slug`);
    }
    map.set(token, slug);
  }
  return map;
}
