#!/usr/bin/env bash
set -euo pipefail

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-convora-test}"
export POSTGRES_DB="${POSTGRES_DB:-convora_test}"
export POSTGRES_USER="${POSTGRES_USER:-convora}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-convora}"
export POSTGRES_PORT="${POSTGRES_PORT:-54330}"
export DATABASE_URL="${DATABASE_URL:-postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}}"

cleanup() {
  if [ "${KEEP_TEST_DB:-0}" != "1" ]; then
    docker compose down -v --remove-orphans >/dev/null
  fi
}
trap cleanup EXIT

docker compose up -d postgres

for attempt in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null; then
    npm run test:node
    exit 0
  fi

  sleep 1
done

echo "Postgres did not become ready in time" >&2
docker compose logs postgres >&2
exit 1
