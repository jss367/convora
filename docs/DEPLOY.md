# Deploying Convora to Render

Convora is a single always-on Node service that serves the React build, the
REST API, and the Socket.IO WebSocket server, backed by a managed Postgres
database. The repo ships a [`render.yaml`](../render.yaml) Blueprint that
provisions both with one click.

## Why this setup

The app holds long-lived WebSocket connections, so it needs a persistent
process (not serverless) and an always-on plan (the free tiers sleep, which
drops live connections). A single small instance comfortably handles ~50–100
concurrent users; you will not need to scale horizontally at that size.

## One-time setup

1. **Merge `render.yaml` to `main`.** Render reads the Blueprint from the
   `main` branch.

2. **Create the services from the Blueprint.** In the Render dashboard:
   **New → Blueprint** → connect this GitHub repo. Render reads `render.yaml`
   and shows a plan: one web service (`convora`) + one database (`convora-db`).
   Review the plans (see note below), then **Apply**.

3. **Wait for the first build/deploy.** Render runs
   `npm install && npm run build`, then `node server.js`. `DATABASE_URL` is
   injected automatically from `convora-db`. When it goes live you get a URL
   like `https://convora.onrender.com`.

   The app starts fine against an empty database — you'll just see no
   discussions until you create some (or restore the backup below).

## Restore the old data (optional)

The repo includes `latest.dump` — a Postgres backup with the original
discussions/questions/votes. To load it into the new database:

1. In Render, open **convora-db → Connect → External Connection** and copy the
   **External Database URL** (host ends in `…-postgres.render.com`, includes
   `sslmode=require`).

2. Restore it. This uses Docker so you don't need Postgres tools installed
   locally — run it from the repo root:

   ```bash
   docker run --rm -v "$PWD/latest.dump:/latest.dump:ro" postgres:16 \
     pg_restore --no-owner --no-acl --clean --if-exists \
     -d "<EXTERNAL_DATABASE_URL>" /latest.dump
   ```

   - `--no-owner --no-acl`: the dump was owned by a Heroku role; this maps it to
     your Render user instead.
   - `--clean --if-exists`: makes re-runs idempotent (safe on an empty DB).
   - You may see a warning about the `pg_stat_statements` extension — it's
     harmless; the tables and rows restore regardless.

3. Reload the site — your discussions should appear.

## Ongoing deploys

`autoDeploy: true` is set, so every push to `main` triggers a rebuild and
redeploy. Nothing else to do.

## Notes

- **Plans / cost.** `render.yaml` uses always-on paid tiers (`starter` web +
  `basic-256mb` db, ballpark ~$7 + ~$7 /mo). Confirm current pricing at
  https://render.com/pricing. You can set both to `free` to try it out, but the
  free web service sleeps (cold starts drop WebSockets) and the free database
  expires — not suitable for real use.
- **Region.** The web service and database must share a region (`oregon` here)
  so they talk over Render's private network. Change both together if you move.
- **No URL config needed.** The client connects same-origin, so you do not need
  to set `REACT_APP_SOCKET_URL` or `CLIENT_URL`. (`CLIENT_URL` only matters if
  you later serve the frontend from a different origin.)
- **Custom domain.** Add it under the web service's **Settings → Custom Domains**;
  Render provisions TLS automatically.
- **Scaling past one instance.** If you ever outgrow a single instance, Socket.IO
  will need a Redis adapter + sticky sessions, and the vote path (which re-queries
  and re-broadcasts the whole question list per vote) should switch to broadcasting
  just the delta. Neither is needed at 50–100 users.
