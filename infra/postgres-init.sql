-- Runs once on first container boot. Idempotent so it's safe to re-run.
-- App migrations live in packages/db/migrations and are run by the app, not here.
-- We only bootstrap extensions here because some require superuser.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
-- H3 is optional and only needed once we cross the Phase 1 traffic threshold.
-- Uncomment when ready, but it requires building from source on most images.
-- CREATE EXTENSION IF NOT EXISTS h3;
-- CREATE EXTENSION IF NOT EXISTS h3_postgis;
