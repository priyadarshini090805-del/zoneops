#!/usr/bin/env bash
# Convenience dev runner. Brings up docker, migrates, seeds, then starts all apps.
# Use `pnpm dev` if you already have the DB up — that just runs the apps.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "[dev] .env missing — copying from .env.example"
  cp .env.example .env
  echo "[dev] EDIT .env to set NEXT_PUBLIC_MAPBOX_TOKEN before continuing." >&2
fi

echo "[dev] starting docker compose..."
pnpm db:up

echo "[dev] waiting for postgres..."
for i in $(seq 1 30); do
  if docker exec zoneops-postgres pg_isready -U zoneops -d zoneops >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "[dev] running migrations..."
pnpm db:migrate

echo "[dev] seeding demo data..."
pnpm seed

echo "[dev] starting all apps (api, worker, web)..."
exec pnpm dev
