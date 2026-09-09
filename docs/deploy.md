# Deploying Tacit (P0)

Two small Fly.io apps built from one image, sharing one Postgres cluster with pgvector. Everything below is `flyctl` from the repo root; nothing is automated that touches your account without you.

| Piece | Where | Why |
|---|---|---|
| `tacit-mcp` | `fly/mcp.fly.toml` | The MCP server engineers connect to (F-SRV). Serves from Postgres. |
| `tacit-admin` | `fly/admin.fly.toml` | The connect flow (F-ADM-1). Needs a stable public URL for OAuth callbacks. |
| `tacit-db` | Fly Postgres | `sync_items`, artifacts, gaps, model_calls. pgvector for the embedding column. |
| compile | one-off machine on the mcp image | `scripts/start.sh compile --org=… --budget=…` |

## 0. Once: install and sign in

```bash
curl -L https://fly.io/install.sh | sh
fly auth login
```

## 1. Postgres with pgvector

```bash
fly postgres create --name tacit-db --region iad --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 10
fly postgres connect -a tacit-db
```

In the psql prompt: `create database tacit; \c tacit` then `create extension if not exists vector;`. Take the connection string `fly postgres connect` prints (or `fly postgres attach` below) — it is the `DATABASE_URL` for both apps.

## 2. Create the apps and attach the database

```bash
fly apps create tacit-mcp
fly apps create tacit-admin
fly postgres attach tacit-db -a tacit-mcp --database-name tacit
fly postgres attach tacit-db -a tacit-admin --database-name tacit
```

`attach` sets `DATABASE_URL` on each app. If you named the apps differently, change `app = …` in the two toml files and `TACIT_PUBLIC_URL` in `fly/admin.fly.toml`.

## 3. Secrets

The org id comes from the first row you create; the seed prints it for the demo org, and a real org is `insert into orgs (name) values ('…') returning id` through `fly postgres connect`.

```bash
# MCP server
fly secrets set -a tacit-mcp TACIT_ORG_ID=<uuid> \
  TACIT_MCP_TOKENS='[{"token":"<32+ random chars>","email":"engineer@partner.example","org_id":"<uuid>"}]'

# Admin (the connect flow)
fly secrets set -a tacit-admin TACIT_ORG_ID=<uuid> \
  TACIT_ADMIN_TOKEN=<32+ random chars> \
  TACIT_MASTER_KEY=$(openssl rand -hex 32) \
  SLACK_CLIENT_ID=… SLACK_CLIENT_SECRET=… \
  GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… \
  GITHUB_APP_SLUG=… GITHUB_APP_ID=… GITHUB_APP_PRIVATE_KEY="$(cat app.private-key.pem)"
```

Generate tokens with `openssl rand -hex 24`. `TACIT_MASTER_KEY` seals OAuth tokens into `source_credentials`; losing it means reconnecting every source, so keep it in your password manager too.

OAuth app registration (once per provider), all with redirect URI `https://tacit-admin.fly.dev/oauth/<kind>/callback`:
- **Slack**: an app with the bot scopes listed on the connect page (all read); install is per workspace via the flow.
- **Google**: an OAuth client (web application) with the Drive API enabled; scope `drive.readonly`.
- **GitHub**: a GitHub App with permissions contents: read, metadata: read, pull requests: read; "Setup URL" = the callback, "Redirect on update" on.

## 4. Deploy

```bash
fly deploy -c fly/mcp.fly.toml      # runs migrations as the release command, then starts the server
fly deploy -c fly/admin.fly.toml
```

Or run the **Deploy** workflow in GitHub Actions (needs the `FLY_API_TOKEN` repository secret from `fly tokens create deploy`).

Check: `curl https://tacit-mcp.fly.dev/healthz` and `https://tacit-admin.fly.dev/login?token=<TACIT_ADMIN_TOKEN>`.

## 5. First org: connect → sync → review → compile → serve

1. Open the admin app, connect a source, choose what to include, review and approve who can see what.
2. Sync and compile from a one-off machine on the mcp image (the sync commands land with the worker; for a demo org, `seed` loads Northwind):

```bash
fly machine run . -c fly/mcp.fly.toml --rm -a tacit-mcp \
  -e ANTHROPIC_API_KEY=<key> -e TACIT_STAGE_CACHE_DIR=/data/stage-cache \
  -- compile --org=<uuid> --budget=20
```

A first compile of a 2,700-item org costs about $15; unchanged re-runs are free because of the stage cache on the `/data` volume.

3. Give each engineer their MCP token and the URL `https://tacit-mcp.fly.dev/mcp` (bearer auth). In Claude Code: `claude mcp add tacit --transport http https://tacit-mcp.fly.dev/mcp --header "Authorization: Bearer <token>"`.
4. Generate the scan report for the champion: `fly machine run … -- eval --serve-out=/data/serve` is the eval path; for a real org use `pnpm scan-report` against a snapshot written from the database (follow-up: report straight from Postgres).

## Day-to-day

- Logs: `fly logs -a tacit-mcp`. Every line is JSON; stage transitions carry `run_id`, `org_id`, tokens, and cost; no source content is ever logged.
- Spend: `select org_id, sum(cost_usd) from model_calls group by 1` — the same rows the eval reports from.
- Rotate an MCP token by editing `TACIT_MCP_TOKENS` and redeploying; revoke a source by setting `revoked_at` on its credential row.
- Scale: both apps are `shared-cpu-1x / 512 MB`; the admin app stops when idle, the MCP app keeps one machine.

## What is not here yet

- Sync as a scheduled job (the connectors run from commands today) and pg-boss for the queue.
- Per-user OAuth on the MCP connection; static tokens are the P0 stand-in.
- A scan report generated straight from Postgres for a real org.
