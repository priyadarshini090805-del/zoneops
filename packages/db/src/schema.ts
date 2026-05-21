import {
  pgTable,
  uuid,
  text,
  timestamp,
  doublePrecision,
} from "drizzle-orm/pg-core";

export const assets = pgTable("assets", {
  id: uuid("id").defaultRandom().primaryKey(),

  label: text("label").notNull(),

  kind: text("kind").notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const assetLocations = pgTable("asset_locations", {
  id: uuid("id").defaultRandom().primaryKey(),

  assetId: uuid("asset_id").notNull(),

  latitude: doublePrecision("latitude").notNull(),

  longitude: doublePrecision("longitude").notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});