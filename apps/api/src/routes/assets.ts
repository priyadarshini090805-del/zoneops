// GET /v1/assets         — list assets in the caller's org
// GET /v1/assets/latest   — latest positions for all active assets (live-map first paint)
import type { FastifyPluginAsync } from "fastify";
import { sql } from "drizzle-orm";

const assets: FastifyPluginAsync = async (app) => {
  app.get("/", async (req) => {
    const auth = await app.requireAuth(req);
    const result = await app.db.db.execute<{
      id: string; external_id: string | null; kind: string; label: string; active: boolean;
    }>(sql`
      SELECT id, external_id, kind, label, active
      FROM assets
      WHERE org_id = ${auth.orgId}
      ORDER BY label
      LIMIT 500
    `);
    return { assets: (result as unknown as { rows: unknown[] }).rows };
  });

  // Returns GeoJSON FeatureCollection so the map can render it directly.
  app.get("/latest", async (req) => {
    const auth = await app.requireAuth(req);
    const result = await app.db.db.execute<{
      asset_id: string; label: string; kind: string; observed_at: string; geom: string;
    }>(sql`
      SELECT
        al.asset_id,
        a.label,
        a.kind,
        al.observed_at,
        ST_AsGeoJSON(al.position::geometry) AS geom
      FROM assets_latest al
      JOIN assets a ON a.id = al.asset_id
      WHERE al.org_id = ${auth.orgId} AND a.active
      ORDER BY al.observed_at DESC
      LIMIT 2000
    `);
    const rows = (result as unknown as {
      rows: { asset_id: string; label: string; kind: string; observed_at: string; geom: string }[];
    }).rows;
    return {
      type: "FeatureCollection" as const,
      features: rows.map((r) => ({
        type: "Feature" as const,
        geometry: JSON.parse(r.geom),
        properties: {
          asset_id: r.asset_id,
          label: r.label,
          kind: r.kind,
          observed_at: r.observed_at,
        },
      })),
    };
  });
};

export default assets;
