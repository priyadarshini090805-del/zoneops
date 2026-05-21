import { FastifyInstance } from "fastify";
import { pool } from "@zoneops/db";

export async function ingestRoutes(app: FastifyInstance) {
  app.post("/ingest/location", async (request, reply) => {
    const body = request.body as {
      assetId: string;
      latitude: number;
      longitude: number;
    };

    const { assetId, latitude, longitude } = body;

    await pool.query(
      `
      INSERT INTO asset_locations (
        asset_id,
        latitude,
        longitude
      )
      VALUES ($1, $2, $3)
      `,
      [assetId, latitude, longitude]
    );

    return reply.send({
      success: true,
    });
  });
}