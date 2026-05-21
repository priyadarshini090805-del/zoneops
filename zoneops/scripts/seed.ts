// Seed script — creates demo orgs, assets, and a couple of geofences so the
// app boots into a non-empty state. Run after `pnpm db:migrate`.
//
//   pnpm seed
//
// Idempotent: re-running won't duplicate rows.
import "dotenv/config";
import { sql } from "drizzle-orm";
import { createDb } from "@zoneops/db";

const DEMO_ORGS = [
  { slug: "acme", name: "Acme Towers" },
  { slug: "northwind", name: "Northwind Field Services" },
];

const DEMO_ASSETS = [
  // External IDs match what the simulator uses.
  { externalId: "TRK-1001", kind: "vehicle" as const, label: "Truck 1001" },
  { externalId: "TRK-1002", kind: "vehicle" as const, label: "Truck 1002" },
  { externalId: "TRK-1003", kind: "vehicle" as const, label: "Truck 1003" },
  { externalId: "TECH-2001", kind: "technician" as const, label: "Alex M." },
  { externalId: "TECH-2002", kind: "technician" as const, label: "Pat L." },
];

// Two small site-compound polygons around Manhattan + Brooklyn. Coordinates are
// [lon, lat]. Easy to eyeball on the demo map.
const DEMO_FENCES = [
  {
    name: "Site 4421 — Lower Manhattan",
    category: "site_compound" as const,
    coords: [
      [-74.010, 40.708], [-74.005, 40.708],
      [-74.005, 40.713], [-74.010, 40.713],
      [-74.010, 40.708],
    ],
  },
  {
    name: "Hazard Zone — Brooklyn Heights",
    category: "hazard" as const,
    coords: [
      [-73.999, 40.694], [-73.992, 40.694],
      [-73.992, 40.701], [-73.999, 40.701],
      [-73.999, 40.694],
    ],
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const { db, pool } = createDb(url);
  try {
    for (const org of DEMO_ORGS) {
      const orgRow = await db.execute<{ id: string }>(sql`
        INSERT INTO orgs (slug, name) VALUES (${org.slug}, ${org.name})
        ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
      `);
      const orgId = (orgRow as unknown as { rows: { id: string }[] }).rows[0]!.id;
      console.log(`[seed] org ${org.slug} -> ${orgId}`);

      // Assets only for the first org so the demo isn't noisy.
      if (org.slug === "acme") {
        for (const a of DEMO_ASSETS) {
          await db.execute(sql`
            INSERT INTO assets (org_id, external_id, kind, label)
            VALUES (${orgId}::uuid, ${a.externalId}, ${a.kind}, ${a.label})
            ON CONFLICT (org_id, external_id) DO UPDATE SET label = EXCLUDED.label
          `);
        }
        console.log(`[seed] inserted ${DEMO_ASSETS.length} assets for acme`);

        for (const f of DEMO_FENCES) {
          const geometry = { type: "Polygon" as const, coordinates: [f.coords] };
          await db.execute(sql`
            INSERT INTO geofences (org_id, name, category, geometry)
            SELECT ${orgId}::uuid, ${f.name}, ${f.category},
                   ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}), 4326)::geography
            WHERE NOT EXISTS (
              SELECT 1 FROM geofences WHERE org_id = ${orgId}::uuid AND name = ${f.name}
            )
          `);
        }
        console.log(`[seed] inserted ${DEMO_FENCES.length} geofences for acme`);
      }
    }
    console.log("[seed] done");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
