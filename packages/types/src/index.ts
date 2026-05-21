// Shared types & validators used by both API and Worker.
// Keep this package zero-runtime-dep beyond zod.
import { z } from "zod";

// ---- Ingestion payloads ------------------------------------------------------

export const LocationPoint = z.object({
  external_asset_id: z.string().min(1).max(128),
  lat: z.number().gte(-90).lte(90),
  lon: z.number().gte(-180).lte(180),
  heading_deg: z.number().gte(0).lt(360).optional(),
  speed_mps: z.number().gte(0).optional(),
  observed_at: z.string().datetime({ offset: true }),
  extras: z.record(z.unknown()).optional(),
});
export type LocationPoint = z.infer<typeof LocationPoint>;

export const IngestLocationsBody = z.object({
  points: z.array(LocationPoint).min(1).max(500),
});
export type IngestLocationsBody = z.infer<typeof IngestLocationsBody>;

// ---- Internal event shapes (Redis Streams) -----------------------------------
// Streams use string fields only, so we serialize JSON for nested objects.

export const StreamLocationIngress = z.object({
  org_id: z.string().uuid(),
  asset_id: z.string().uuid(),
  lat: z.number(),
  lon: z.number(),
  heading_deg: z.number().optional(),
  speed_mps: z.number().optional(),
  observed_at: z.string().datetime({ offset: true }),
});
export type StreamLocationIngress = z.infer<typeof StreamLocationIngress>;

export const FenceEvent = z.object({
  type: z.enum(["enter", "exit"]),
  org_id: z.string().uuid(),
  asset_id: z.string().uuid(),
  geofence_id: z.string().uuid(),
  at: z.string().datetime({ offset: true }),
});
export type FenceEvent = z.infer<typeof FenceEvent>;

// ---- Geofence I/O ------------------------------------------------------------

export const GeoJsonPolygon = z.object({
  type: z.literal("Polygon"),
  coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
});
export type GeoJsonPolygon = z.infer<typeof GeoJsonPolygon>;

export const CreateGeofenceBody = z.object({
  name: z.string().min(1).max(200),
  category: z.enum(["site_compound", "hazard", "restricted", "jurisdiction", "custom"]),
  geometry: GeoJsonPolygon,
  metadata: z.record(z.unknown()).optional(),
});
export type CreateGeofenceBody = z.infer<typeof CreateGeofenceBody>;

// ---- Redis stream / key naming -----------------------------------------------
// Centralized so API and Worker can't drift.

export const Streams = {
  locationIngress: "stream:location_ingress",
  fenceEvents: "stream:fence_events",
} as const;

export function fenceMembershipKey(assetId: string): string {
  return `asset:${assetId}:fences`;
}

export function liveChannel(orgId: string): string {
  return `live:${orgId}`;
}
