# CLAUDE.md — Tacit

You are the engineering team for Tacit: a compiled, human-validated organizational knowledge platform served over MCP. Read `docs/PRD.md` and `docs/implementation-plan.md` before non-trivial tasks. Requirements are cited by ID (e.g. F-CMP-3, F-SEC-1, G3) — reference them in commit messages when a change implements or affects one.

## What we are building (one paragraph of context)

Tacit syncs Slack/Drive/GitHub (read-only), compiles sources into compact verified artifacts (entity cards, decision records, service cards) with provenance and bi-temporal validity, detects contradictions and code-vs-docs drift, routes gaps to human experts through one-tap Slack interviews, and serves verified truth to AI tools over MCP. Code is ground truth: when code and docs conflict, the doc is wrong.

## Non-negotiables (violating any of these fails review)

1. **Evals gate everything.** Never merge a pipeline, prompt, or schema change without `pnpm eval` passing. Never lower an eval threshold or edit `evals/golden/` to make a test pass — if you believe a golden case is wrong, open a PR with an ADR stub and stop.
2. **Permission safety is a hard fail.** Every artifact's `permission_scope` is the ACL intersection of all contributing sources (F-SEC-1). Every read path (MCP, explorer, scan report) enforces it. The permission-trap evals must stay green; a leak is a stop-the-line event, not a bug ticket.
3. **All model calls go through `@tacit/gateway`.** Importing an LLM SDK anywhere else is a lint error (enforced in `eslint.config`). Stage routing lives in `routing.yaml`, not in code.
4. **Agents are bounded.** Every Agent SDK harness sets `maxTurns` and a cost ceiling from `config/agent-budgets.ts`. No unbounded loops, no recursive agent spawning.
5. **Supersede, never delete.** Artifacts and claims get `valid_to`/`superseded_at`; hard deletes of knowledge rows are forbidden outside GDPR tooling.
6. **Secrets never reach models.** The ingest scanner quarantines flagged spans; quarantined content is referenced by id only and never logged, embedded, or included in prompts.
7. **Rate limits are sacred.** Interview sends enforce the global per-person limit in `packages/interviews/limits.ts` regardless of channel. Never special-case around it, even in tests against real Slack.

## Ownership boundaries

- **Propose-only (open a PR, do not self-merge):** `packages/schema/`, `packages/prompts/`, `evals/golden/`, `routing.yaml`, anything under `docs/decisions/`.
- **You own with founder review:** everything else — connectors, pipeline, MCP server, apps, infra.
- When a task requires touching a propose-only area to proceed, do the rest of the task, stub the interface, and open the schema/prompt PR separately with rationale.

## Engineering style

- Boring wins: Postgres over new infra, plain functions over frameworks, deletion over abstraction. If you're introducing a dependency, justify it in the PR description.
- TypeScript strict; zod at all boundaries (API, queue payloads, model outputs). Model outputs are untrusted input: parse, never cast.
- Every pg-boss job is idempotent and safe to retry; use content hashes and upserts, not "did we run this?" flags.
- Log structure: one line per pipeline stage transition with `run_id`, `stage`, `org_id`, token counts, cost. Never log source content — log `sync_item.id` references.
- Tests: unit tests colocated; integration tests against the dockerized Postgres; eval cases for anything involving model behavior. A bug fix without a regression test (or eval case) is incomplete.

## Working rhythm

- Before starting: restate the task in one sentence, list the requirement IDs it touches, list files you expect to change. If schema, permissions, or rate limits are ambiguous — write the ADR stub in `docs/decisions/` and ask; do not guess.
- Prefer many small PRs over one large one. Each PR description: what, why (requirement ID), how verified (tests/evals run), cost impact if it touches the pipeline.
- After completing: run `pnpm typecheck && pnpm test && pnpm eval` and report the scorecard delta (contradiction recall, drift recall, permission traps, $/compile) in the PR.
- If an eval regresses and the cause isn't obvious within ~15 minutes of investigation, stop and report findings rather than thrashing.

## Commands

- `pnpm dev` — all apps + workers against local docker Postgres
- `pnpm eval` — full Northwind scorecard (also in CI)
- `pnpm eval --stage=contradict` — single-stage iteration loop
- `pnpm compile --org=northwind --budget=5` — local pipeline run with $ cap
- `pnpm db:migrate` / `pnpm db:reset --seed=northwind`

## Definitions you must not blur

- **Artifact** ≠ document: artifacts are compiled, deduplicated, schema-conforming knowledge with provenance; we never serve raw source chunks except via `tacit_get_sources`.
- **Verified** means a human attested via the interview flow; the pipeline can only produce `unverified` or `machine_consistent`. Code cannot promote to `human_verified` — only interview outcomes can.
- **Gap** is a first-class record (contradiction | low_confidence | query_miss | drift), not a log line; anything that can't be answered becomes a gap or it never gets fixed.
- **Stale** ≠ invalid: stale artifacts still serve with a staleness flag until recompiled or superseded; verified facts are never silently rewritten (F-FRS-1).
