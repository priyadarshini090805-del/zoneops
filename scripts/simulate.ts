// Telemetry simulator — POSTs randomized GPS points to /v1/ingest/locations
// every second. Use to validate the whole pipeline end-to-end: ingest →
// stream → worker → SSE → map.
//
//   pnpm tsx scripts/simulate.ts
//
// Tunables via env:
//   SIM_BEARER         API bearer token (default: dev-token-acme)
//   SIM_API_BASE       API base URL    (default: http://localhost:4000)
//   SIM_RATE_HZ        points per second per asset (default: 1)
//   SIM_DURATION_SEC   stop after N seconds, 0 = forever (default: 0)
import "dotenv/config";

const API_BASE = process.env.SIM_API_BASE ?? "http://localhost:4000";
const BEARER = process.env.SIM_BEARER ?? "dev-token-acme";
const RATE_HZ = Number(process.env.SIM_RATE_HZ ?? 1);
const DURATION_SEC = Number(process.env.SIM_DURATION_SEC ?? 0);

// Match seed.ts.
const ASSETS = ["TRK-1001", "TRK-1002", "TRK-1003", "TECH-2001", "TECH-2002"];

// Random walk anchored near the demo geofences so an "enter" actually fires.
const START_NEAR: Record<string, [number, number]> = {
  "TRK-1001": [-74.0075, 40.7100],     // wandering into Site 4421
  "TRK-1002": [-73.9955, 40.6960],     // wandering into Brooklyn Heights hazard
  "TRK-1003": [-74.020, 40.720],
  "TECH-2001": [-74.008, 40.711],
  "TECH-2002": [-73.997, 40.696],
};
const position: Record<string, [number, number]> = { ...START_NEAR };

function step([lon, lat]: [number, number]): [number, number] {
  // ~5–15m per tick.
  const dLon = (Math.random() - 0.5) * 0.0002;
  const dLat = (Math.random() - 0.5) * 0.0002;
  return [lon + dLon, lat + dLat];
}

async function postBatch() {
  const points = ASSETS.map((eid) => {
    const next = step(position[eid]!);
    position[eid] = next;
    return {
      external_asset_id: eid,
      lat: next[1],
      lon: next[0],
      heading_deg: Math.floor(Math.random() * 360),
      speed_mps: Math.random() * 8,
      observed_at: new Date().toISOString(),
    };
  });
  const res = await fetch(`${API_BASE}/v1/ingest/locations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BEARER}`,
    },
    body: JSON.stringify({ points }),
  });
  if (!res.ok) {
    console.error(`[sim] ${res.status} ${await res.text()}`);
    return;
  }
  const data = (await res.json()) as { accepted: number };
  console.log(`[sim] sent ${data.accepted}/${points.length}`);
}

async function main() {
  const intervalMs = 1000 / RATE_HZ;
  const start = Date.now();
  const tick = async () => {
    await postBatch().catch((err) => console.error("[sim] error", err));
    if (DURATION_SEC > 0 && Date.now() - start > DURATION_SEC * 1000) {
      console.log("[sim] done");
      process.exit(0);
    }
  };
  await tick();
  setInterval(tick, intervalMs);
}

main();
