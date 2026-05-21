-- 0000_init.sql
-- Initial schema. Mirrors §3 of the planning doc, scoped to MVP-1 only.
-- Extensions are bootstrapped in infra/postgres-init.sql (superuser required).

-- ============================================================================
-- Tenancy
-- ============================================================================

CREATE TABLE orgs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  plan       TEXT NOT NULL DEFAULT 'trial',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Users skipped for MVP-1: a bearer token maps directly to an org_id via env.
-- We'll add `users` in the auth pass; doing so now would be wasted plumbing.

-- ============================================================================
-- Assets
-- ============================================================================

CREATE TABLE assets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  external_id TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('technician','vehicle','equipment','site')),
  label       TEXT NOT NULL,
  attributes  JSONB NOT NULL DEFAULT '{}'::jsonb,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, external_id)
);
CREATE INDEX idx_assets_org_kind ON assets (org_id, kind) WHERE active;

-- Latest known location per asset. UPSERTed on every ingest.
-- This is the hot read path for the live map.
CREATE TABLE assets_latest (
  asset_id    UUID PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  position    geography(Point, 4326) NOT NULL,
  heading_deg REAL,
  speed_mps   REAL,
  observed_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_assets_latest_org ON assets_latest (org_id);
CREATE INDEX idx_assets_latest_position ON assets_latest USING GIST (position);

-- Historical breadcrumb stream. Partitioned by month.
-- We define the parent table here; partitions are created by a maintenance job
-- or the 0001_partition_helper.sql migration on first install.
CREATE TABLE asset_locations (
  id          BIGSERIAL,
  org_id      UUID NOT NULL,
  asset_id    UUID NOT NULL,
  position    geography(Point, 4326) NOT NULL,
  heading_deg REAL,
  speed_mps   REAL,
  observed_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source      TEXT NOT NULL,
  PRIMARY KEY (observed_at, id)
) PARTITION BY RANGE (observed_at);

CREATE INDEX idx_asset_locations_org_asset
  ON asset_locations (org_id, asset_id, observed_at DESC);
CREATE INDEX idx_asset_locations_position
  ON asset_locations USING GIST (position);
CREATE INDEX idx_asset_locations_brin
  ON asset_locations USING BRIN (observed_at);

-- ============================================================================
-- Geofences
-- ============================================================================

CREATE TABLE geofences (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  category   TEXT NOT NULL CHECK (category IN
              ('site_compound','hazard','restricted','jurisdiction','custom')),
  geometry   geography(Polygon, 4326) NOT NULL,
  source     TEXT NOT NULL DEFAULT 'drawn',
  metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_geofences_org_geom
  ON geofences USING GIST (org_id, geometry) WHERE active;
CREATE INDEX idx_geofences_category
  ON geofences (org_id, category) WHERE active;

-- ============================================================================
-- Fence membership (current state cache, also kept in Redis)
-- ============================================================================

CREATE TABLE asset_fence_membership (
  org_id       UUID NOT NULL,
  asset_id     UUID NOT NULL,
  geofence_id  UUID NOT NULL,
  entered_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (asset_id, geofence_id)
);
CREATE INDEX idx_afm_org_fence ON asset_fence_membership (org_id, geofence_id);

-- ============================================================================
-- Fence events (audit + replay for MVP-1; supersedes rule_fires later)
-- ============================================================================

CREATE TABLE fence_events (
  id           BIGSERIAL PRIMARY KEY,
  org_id       UUID NOT NULL,
  asset_id     UUID NOT NULL,
  geofence_id  UUID NOT NULL,
  event_type   TEXT NOT NULL CHECK (event_type IN ('enter','exit')),
  at           TIMESTAMPTZ NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_fence_events_org_time ON fence_events (org_id, at DESC);
CREATE INDEX idx_fence_events_asset_time ON fence_events (asset_id, at DESC);
