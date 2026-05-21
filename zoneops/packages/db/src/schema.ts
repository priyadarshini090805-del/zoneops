// Drizzle schema. App-level type-safe queries use this.
// Spatial columns (geography) are exposed as TEXT in the type system because
// Drizzle has no first-class PostGIS support. We read/write them via raw sql``
// using ST_AsGeoJSON / ST_GeogFromText where needed (see API ingest route).
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  jsonb,
  bigserial,
  real,
  customType,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Custom Drizzle types for PostGIS columns. The TS shape is `string` (WKT/GeoJSON),
// but always go through sql`` helpers below when reading or writing.
const geographyPoint = customType<{ data: string; driverData: string }>({
  dataType() {
    return "geography(Point, 4326)";
  },
});

const geographyPolygon = customType<{ data: string; driverData: string }>({
  dataType() {
    return "geography(Polygon, 4326)";
  },
});

export const orgs = pgTable("orgs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  plan: text("plan").notNull().default("trial"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    kind: text("kind").$type<"technician" | "vehicle" | "equipment" | "site">().notNull(),
    label: text("label").notNull(),
    attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgExternal: uniqueIndex("uq_assets_org_external").on(t.orgId, t.externalId),
  }),
);

export const assetsLatest = pgTable("assets_latest", {
  assetId: uuid("asset_id").primaryKey().references(() => assets.id, { onDelete: "cascade" }),
  orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  position: geographyPoint("position").notNull(),
  headingDeg: real("heading_deg"),
  speedMps: real("speed_mps"),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

// asset_locations is partitioned; Drizzle treats the parent table identically.
// We rarely query it from app code (the worker writes; reads are time-windowed and
// usually go through raw SQL anyway), so we don't expose every field here.
export const assetLocations = pgTable("asset_locations", {
  id: bigserial("id", { mode: "number" }),
  orgId: uuid("org_id").notNull(),
  assetId: uuid("asset_id").notNull(),
  position: geographyPoint("position").notNull(),
  headingDeg: real("heading_deg"),
  speedMps: real("speed_mps"),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  source: text("source").notNull(),
});

export const geofences = pgTable("geofences", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category")
    .$type<"site_compound" | "hazard" | "restricted" | "jurisdiction" | "custom">()
    .notNull(),
  geometry: geographyPolygon("geometry").notNull(),
  source: text("source").notNull().default("drawn"),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const assetFenceMembership = pgTable(
  "asset_fence_membership",
  {
    orgId: uuid("org_id").notNull(),
    assetId: uuid("asset_id").notNull(),
    geofenceId: uuid("geofence_id").notNull(),
    enteredAt: timestamp("entered_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.assetId, t.geofenceId] }),
    orgFence: index("idx_afm_org_fence").on(t.orgId, t.geofenceId),
  }),
);

export const fenceEvents = pgTable(
  "fence_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id").notNull(),
    assetId: uuid("asset_id").notNull(),
    geofenceId: uuid("geofence_id").notNull(),
    eventType: text("event_type").$type<"enter" | "exit">().notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgTime: index("idx_fence_events_org_time").on(t.orgId, t.at),
    assetTime: index("idx_fence_events_asset_time").on(t.assetId, t.at),
  }),
);

export type Asset = typeof assets.$inferSelect;
export type Org = typeof orgs.$inferSelect;
export type Geofence = typeof geofences.$inferSelect;
export type FenceEvent = typeof fenceEvents.$inferSelect;
