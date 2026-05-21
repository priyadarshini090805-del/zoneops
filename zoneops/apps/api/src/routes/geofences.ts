// Geofence CRUD. MVP: create (GeoJSON polygon), list (GeoJSON), delete.
// KML/SHP import deferred — ship one shape at a time.
import type { FastifyPluginAsync } from "fastify";
import { sql } from "drizzle-orm";
import { CreateGeofenceBody } from "@zoneops/types";

const geofences: FastifyPluginAsync = async (app) => {
  app.get("/", async (req) => {
    const auth = await app.requireAuth(req);
    const result = await app.db.db.execute<{
      id: string; name: string; category: string; geom: string; created_at: string;
    }>(sql`
      SELECT id, name, category, ST_AsGeoJSON(geometry::geometry) AS geom, created_at
      FROM geofences
      WHERE org_id = ${auth.orgId} AND active
      ORDER BY created_at DESC
    `);
    const rows = (result as unknown as {
      rows: { id: string; name: string; category: string; geom: string; created_at: string }[];
    }).rows;
    return {
      type: "FeatureCollection" as const,
      features: rows.map((r) => ({
        type: "Feature" as const,
        id: r.id,
        geometry: JSON.parse(r.geom),
        properties: { id: r.id, name: r.name, category: r.category, created_at: r.created_at },
      })),
    };
  });

  app.post("/", async (req, reply) => {
    const auth = await app.requireAuth(req);
    const body = CreateGeofenceBody.parse(req.body);

    // ST_GeomFromGeoJSON validates topology and SRID; malformed polygons -> PG error -> 400.
    const result = await app.db.db.execute<{ id: string }>(sql`
      INSERT INTO geofences (org_id, name, category, geometry, metadata)
      VALUES (
        ${auth.orgId}::uuid,
        ${body.name},
        ${body.category},
        ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(body.geometry)}), 4326)::geography,
        ${JSON.stringify(body.metadata ?? {})}::jsonb
      )
      RETURNING id
    `);
    const id = (result as unknown as { rows: { id: string }[] }).rows[0]!.id;

    // Tell the worker to reload its fence cache and reconcile memberships.
    await app.redis.publish(
      "zoneops:geofences:changed",
      JSON.stringify({ org_id: auth.orgId, id }),
    );

    return reply.code(201).send({ id });
  });

  app.delete<{ Params: { id: string } }>("/:id", async (req) => {
    const auth = await app.requireAuth(req);
    await app.db.db.execute(sql`
      UPDATE geofences SET active = false, updated_at = now()
      WHERE id = ${req.params.id}::uuid AND org_id = ${auth.orgId}
    `);
    await app.redis.publish(
      "zoneops:geofences:changed",
      JSON.stringify({ org_id: auth.orgId, id: req.params.id }),
    );
    return { ok: true };
  });
};

export default geofences;
