# ZoneOps

Operational automation based on spatial context — telecom field-ops wedge. This repo is the MVP-1 scaffold: ingest GPS points, render them on a live map, draw geofences, detect fence-enter events. Nothing more, by design.

## Layout

```
zoneops/
├── apps/
│   ├── api/         Fastify HTTP API + SSE
│   ├── worker/      Redis Streams consumer + spatial reconciliation
│   └── web/         Next.js 14 (App Router) — Mapbox live map
├── packages/
│   ├── config/      Env loader (zod-validated)
│   ├── db/          Drizzle schema + SQL migrations + tiny migrator
│   └── types/       Shared zod schemas + stream key names
├── infra/
│   └── docker-compose.yml   Postgres+PostGIS, Redis
├── scripts/
│   ├── seed.ts      Demo orgs, assets, geofences
│   ├── simulate.ts  Posts moving GPS points so the map shows life
│   └── dev.sh       One-shot: docker up + migrate + seed + run apps
└── pnpm-workspace.yaml
```

## Tech choices, briefly

- **pnpm workspaces** for the monorepo. Faster than npm/yarn for our shape; symlink-based so workspace packages resolve without a build step.
- **Fastify** for the API. Schema-first, faster than Express, and the plugin model keeps the server file boring.
- **Drizzle ORM** for type-safe app queries. SQL migrations are hand-written because PostGIS columns, GIST indexes, partial indexes, and partitioning don't survive Drizzle Kit's introspection cleanly. We get the best of both: types for app code, hand-written SQL for schema.
- **Redis Streams** (not Kafka) for the ingest → worker pipeline. Streams give us consumer groups, replay, and back-pressure with one fewer system to run. Kafka graduation criteria documented in the planning doc (§8).
- **PostGIS** as the spatial engine. Single-digit ms point-in-polygon at MVP volumes; H3 pre-filter goes in once we cross a real threshold.
- **Server-Sent Events** for the live map. One-way, works through every proxy, no special infra.
- **No build step in dev.** `tsx` runs TS directly; `tsc --noEmit` does type-checks.

## Prerequisites

- Node 20+ (`node --version`)
- pnpm 9+ (`npm i -g pnpm`)
- Docker + Compose
- A Mapbox public token (set `NEXT_PUBLIC_MAPBOX_TOKEN`)

## First boot

```bash
# 1. install dependencies
pnpm install

# 2. environment
cp .env.example .env
$EDITOR .env   # set NEXT_PUBLIC_MAPBOX_TOKEN

# 3. start postgres + redis
pnpm db:up

# 4. apply schema migrations
pnpm db:migrate

# 5. seed demo data (one org, five assets, two geofences)
pnpm seed

# 6. run api + worker + web in parallel
pnpm dev

# 7. in a second terminal, generate moving telemetry
pnpm tsx scripts/simulate.ts
```

Open <http://localhost:3000/map>. You should see five markers wandering around lower Manhattan, and `fence_event` lines in the worker logs as they cross the seeded geofences.

Or, one shot:

```bash
./scripts/dev.sh
```

## Smoke test (no UI)

```bash
TOKEN=dev-token-acme

# Ingest one point
curl -s -X POST http://localhost:4000/v1/ingest/locations \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"points":[{"external_asset_id":"TRK-1001","lat":40.7100,"lon":-74.0075,"observed_at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}]}'

# Read latest positions
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/v1/assets/latest | jq

# List geofences
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/v1/geofences | jq

# Stream live events
curl -N -H "Authorization: Bearer $TOKEN" http://localhost:4000/v1/stream/live
```

## Dev workflow

| Task | Command |
|------|---------|
| Start dependencies | `pnpm db:up` |
| Reset DB + reseed | `pnpm db:reset` |
| Watch the API | `pnpm dev:api` |
| Watch the worker | `pnpm dev:worker` |
| Watch the web app | `pnpm dev:web` |
| Type-check everything | `pnpm typecheck` |
| Tail Postgres logs | `pnpm db:logs` |
| Create a new migration | Drop a `NNNN_name.sql` into `packages/db/migrations/`, run `pnpm db:migrate` |

## Boot sequence (what runs when)

1. **`docker-compose up`** — Postgres applies `infra/postgres-init.sql` (extensions only) on first boot.
2. **`pnpm db:migrate`** — applies SQL files in `packages/db/migrations/` in order, records them in `_migrations`. Re-runnable.
3. **`pnpm seed`** — idempotent: creates `acme`/`northwind` orgs, 5 assets on acme, 2 fences on acme.
4. **API** (`apps/api`) boots, validates env, opens pg pool + redis client, mounts routes.
5. **Worker** (`apps/worker`) boots, ensures partitions, joins `zoneops-workers` consumer group on `stream:location_ingress`, blocks for messages.
6. **Web** (`apps/web`) renders `/map`; on mount fetches `/v1/assets/latest` and `/v1/geofences`, opens SSE to `/v1/stream/live`.

## What's intentionally missing

- **No user/session auth.** A bearer-token-to-org map in `API_TOKENS` is the whole auth model. Replace before any external user touches this.
- **No rule DSL.** Fence-enter goes straight to `fence_events`. The DSL/engine in the planning doc lands in Phase 2.
- **No notifications.** Slack/webhook/email dispatching is Phase 2.
- **No KML/SHP import.** GeoJSON POST + browser draw only.
- **No weather provider.** Phase 3.
- **No simulation/shadow mode.** Phase 3.
- **No tests.** Add Vitest in Phase 0.5 once a piece breaks twice and we know what's worth covering.

## Tradeoff notes

A few decisions worth flagging because they'll come up:

- **Auto-provision of unknown `external_asset_id`s in the ingest endpoint.** Fast path to "trucks on a map." Tighten before paid customers — at minimum, gate auto-provision per-integration.
- **SSE uses `fetch` + stream parsing in the web client** instead of `EventSource`. The browser's `EventSource` can't send custom headers, and we use a Bearer token. Production would put a same-origin proxy in front of the API and switch to `EventSource` for the auto-reconnect.
- **Worker XACKs on failure.** No DLQ yet — we'd rather see real failure modes before designing for them. Pending-list reclaim will be the first add when ingest gets flaky.
- **`assets_latest` UPSERTs are done one row per statement inside a transaction**, not as a single multi-row INSERT. The row-count is small (typically <50), and the per-row WHERE clause for out-of-order protection is awkward to express in a bulk INSERT. Revisit if ingest CPU climbs.
- **Geofence-change reconciliation is intentionally incomplete.** The API publishes `zoneops:geofences:changed` and the worker logs it, but doesn't yet rebuild memberships. Hand-fix: re-ingest a recent point per asset, or add a reconcile job — that's the next ticket after the scaffold lands.
