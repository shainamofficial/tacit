# Tacit — Implementation Plan

**Working name:** Tacit (pending trademark clearance; fallbacks: Tacit Labs, Emet)
**Team:** Founder(s) + Claude Code as engineering team, Claude Agent SDK as agent runtime
**Companion doc:** PRD v0.1 (artifact schema, functional requirements F-*, goals G1–G5)

---

## 1. Guiding constraints (decisions already made — do not relitigate mid-build)

1. **Eval harness before pipeline.** Nothing merges into a compile stage without a golden-set regression test. This is what lets Claude Code iterate autonomously.
2. **Deterministic pipeline + agents only where agency pays.** The compile pipeline is boring queue-and-workers code with LLM calls. The Agent SDK is used for exactly three things: the codebase archaeologist, the judge's escalation path, and (P1) the interview agent. Every agentic run has turn caps and spend ceilings.
3. **Frontier-first behind a gateway.** All model calls go through the gateway from day 1, but everything routes to Claude until judge edit-rates justify down-tiering. Do not optimize model mix before design partners exist.
4. **Founder plays the interview agent manually for ≥1 month.** The interview service ships in P1 only after the manual playbook proves ≥70% response rates are achievable.
5. **Permissions are inherited, never invented.** ACL capture at ingest; ACL-intersection scoping on artifacts; enforcement at serve time. Built in P0, not retrofitted.
6. **Code is ground truth.** Drift detection (code vs. docs) is the flagship demo and gets P0 priority even where other connectors are deeper.
7. **Supersede, never delete.** Bi-temporal validity on every artifact from the first migration.

## 2. Tech stack

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript end-to-end (Node 22) | One language for pipeline, MCP server, web; Agent SDK TS support; Claude Code velocity |
| Monorepo | pnpm workspaces + Turborepo | Simple, fast, Claude Code-friendly |
| DB | Postgres 16 + pgvector | Artifacts, sync store, queues, embeddings in one system; boring and auditable |
| Queue/orchestration | pg-boss (Postgres-backed jobs) in P0 → Temporal if/when needed | No extra infra pre-revenue; resumable, idempotent workers |
| Model gateway | Thin internal `@tacit/gateway` wrapping Anthropic SDK + OpenAI-compatible providers (Fireworks/Together) | Per-stage routing config, cost/latency logging, fallbacks; avoids LiteLLM dependency lock-in but mirrors its interface |
| Agent runtime | Claude Agent SDK (TS) | Archaeologist, judge escalations, P1 interviewer |
| MCP server | Official MCP TS SDK, stateless HTTP + OAuth per user | F-SRV requirements |
| Web (admin + explorer) | Next.js + shadcn/ui | Fast to build, fine to throw away |
| Slack | Bolt for JS | Interview bot + @tacit bot |
| Infra | Fly.io or Railway (P0–P1) → AWS for VPC SKU (P2) | Speed now, enterprise later |
| Secrets scanning | trufflehog + custom entropy pass at ingest | F-ING-5 |
| Observability | OpenTelemetry → Grafana Cloud; per-stage cost dashboards from gateway logs | Judge edit-rate and $/corpus-GB are first-class metrics |

## 3. Repo structure

```
tacit/
├── CLAUDE.md                  # Claude Code working agreement (see §9)
├── docs/
│   ├── PRD.md                 # source of truth for requirements
│   ├── decisions/             # ADRs — one file per irreversible choice
│   └── runbooks/
├── packages/
│   ├── schema/                # artifact JSON Schemas + zod types + migrations (VERSIONED, human-owned)
│   ├── gateway/               # model routing, cost logging, caching
│   ├── prompts/               # compile-stage prompts as versioned .md + params (human-owned)
│   ├── connectors/
│   │   ├── slack/
│   │   ├── gdrive/
│   │   ├── github/
│   │   └── zendesk/           # P1
│   ├── pipeline/              # filter → extract → draft → judge → contradict stages
│   ├── artifacts/             # artifact store: CRUD, ACL-intersection, bi-temporal queries
│   ├── drift/                 # code-vs-docs drift detection
│   ├── agents/                # Agent SDK harnesses: archaeologist, judge-escalation, interviewer (P1)
│   ├── interviews/            # channel-agnostic interview objects + Slack/email adapters (P1)
│   ├── graph/                 # validation graph (P1)
│   └── mcp-server/            # tiered retrieval tools, per-user auth
├── apps/
│   ├── admin/                 # connect flow, scan report, dashboard
│   ├── explorer/              # P1: read-only artifact browser + classic search
│   └── workers/               # pg-boss worker entrypoints
├── evals/
│   ├── corpus/                # synthetic company (see §4)
│   ├── golden/                # expected outputs per stage
│   └── run.ts                 # eval runner; CI-gated
└── infra/                     # IaC, deploy configs; helm/ (P2)
```

Ownership rule: `packages/schema`, `packages/prompts`, `evals/` are founder-edited with Claude Code assisting. Everything else Claude Code owns with founder review.

## 4. Phase 0 — Eval harness first (Week 0, before any product code)

Build **Northwind Robotics**, a synthetic 60-person company corpus:

- ~40 Google-Docs-style markdown files (policies, onboarding, runbooks, pricing)
- ~2,000 synthetic Slack messages across 8 channels (generated by Claude, seeded with real-world texture)
- A small but real TypeScript monorepo (3 services, CODEOWNERS, 150 commits of history with PR descriptions)
- ~200 Zendesk-style tickets and 12 macros
- **Planted defects (the answer key):** 25 cross-source contradictions (incl. the canonical 14-day vs 30-day refund), 15 stale-doc-vs-code drifts, 10 tribal-knowledge gaps (true facts that exist in no document, only implied), 5 permission traps (facts derivable only from restricted sources)

Eval runner asserts per stage: contradiction recall/precision, drift recall, artifact factuality vs. sources (LLM-judged with rubric), permission-scope correctness (any leak = hard fail), and token cost per corpus compile. CI fails on regression. Targets to start: ≥80% contradiction recall, ≥90% drift recall, zero permission leaks.

Deliverable: `pnpm eval` runs end-to-end and prints a scorecard. Estimated effort: 3–4 days with Claude Code generating the corpus from founder-written specs.

---

## 5. P0 — Prove the wedge (Weeks 1–6)

### Week 1 — Foundations
- Monorepo scaffold, CI (typecheck, tests, `pnpm eval` gate), deploy pipeline to staging.
- `@tacit/gateway`: `complete(stage, messages, opts)` with per-stage config file (`routing.yaml`), Anthropic provider, prompt-caching support, cost/latency logging to Postgres. All routes → Claude for now.
- Core migrations: `sources`, `sync_items` (content-hash, ACL json, raw pointer), `artifacts` (schema per PRD §13, bi-temporal columns), `claims`, `provenance`, `gaps`, `pipeline_runs`, `model_calls`.
- Secrets scanning module wired into the ingest path; flagged spans quarantined (F-ING-5).

### Week 2 — Connectors (read-only) + sync store
- GitHub App: repo metadata, default-branch tree, PR titles/bodies/reviews, CODEOWNERS, webhook on merge (F-ING-2, F-CODE-2 trigger).
- Google Drive: OAuth, changes API delta sync, per-file ACL capture, export-to-text for Docs.
- Slack: OAuth, channel scoping UI stub, history backfill for included channels, membership-as-ACL.
- Dedup discipline: per-item and per-chunk content hashes; unchanged → skipped (F-ING-6). Eval: re-sync of unchanged corpus costs ~0 model tokens.

### Week 3 — Compile pipeline v1
- pg-boss stages: `filter` → `extract` → `draft` → `judge` → `contradict`, all idempotent, resumable, per-source budget caps (F-CMP-2).
- Prompts land in `packages/prompts` with param schemas; judge returns `approve | edit(diff) | escalate(reason)`; edit-rate logged per stage (the down-tiering signal).
- Artifact writer enforces schema, provenance spans, ACL-intersection `permission_scope` (F-SEC-1).
- Contradiction discovery pass over drafted claims; verified pairwise checks; output → `gaps` table.
- **Gate:** eval scorecard hits Week-3 targets on Northwind before proceeding.

### Week 4 — Codebase layer + drift detection (the demo weapon)
- `service_card` and `api_surface` generation from repo analysis; decision-record mining from PR bodies (F-CODE-1).
- Drift engine: code-derived facts vs. doc/macro claims; code wins; emit diff-linked findings (F-CODE-3).
- Merge-webhook incremental pass: diff → affected-artifact map → stale-mark or auto-update; judge reviews anything touching `human_verified` (F-CODE-2, F-FRS-1).
- Archaeologist agent (Agent SDK) v0: given a flagged drift, trace code → PR → Slack thread; hard caps: 30 turns, $2/run.

### Week 5 — MCP server + scan report
- MCP tools: `tacit_lookup` (index, ~100 tokens), `tacit_get_artifact`, `tacit_get_sources` (F-SRV-1); every response carries verification state + provenance links (F-SRV-2); per-user OAuth; ACL filter at query time (F-SRV-3); query-miss logging (F-SRV-4).
- Tool descriptions engineered per adoption strategy ("always consult first for company questions; costs ~100 tokens").
- **Contradiction-scan report** (F-ADM-4): connect 2+ sources → compile → HTML/PDF report of contradictions + drift findings with deep links + headline hours-saved estimate. Target: unassisted, <1 hour wall-clock on a 50-person org.
- Minimal admin: OAuth connect flow, channel/repo scoping, permission-mapping review screen (F-ADM-1).

### Week 6 — Design-partner readiness + manual interview loop
- Onboard 3 design partners end-to-end; founder runs scan live.
- **Manual interview playbook** (founder-as-agent for ≥1 month): pick top-10 gaps per org from `gaps` table weekly; DM knowers personally in their Slack using the one-tap question format (typed by hand); log every question, response time, and outcome into `interviews` table — this data seeds the validation graph and proves/kills G3 cheaply.
- Instrument everything: MCP connection retention, per-query tokens served, coverage rate.

**P0 exit criteria (from PRD):** scan works unassisted on 3 partners; ≥1 partner's engineers keep the MCP connection enabled voluntarily after 2 weeks; founder-run interviews show a credible path to ≥70% response.

---

## 6. P1 — Close the loop (Weeks 7–16)

- **Interview service** (F-INT-1..6): channel-agnostic `interview` object; Slack adapter with one-tap blocks (`14 days / 30 days / It's complicated → / Not my area →`), threaded "it's complicated" flow where the drafted artifact is shown back for approval; email adapter as fallback (signed one-click links) for non-Slack knowers; **global per-person rate limit (default 2/week), quiet hours, 30-day no-repeat**.
- **Interviewer agent** (Agent SDK): question formulation from gap + provenance context; frontier-tier; every question passes a "would a busy engineer respect this?" rubric check before send.
- **Validation graph** (F-INT-1): per-person knowledge areas from edit history/threads/CODEOWNERS + response rate + confirmation accuracy; drives routing; "why you were asked" string generated from graph evidence.
- **Cross-validation:** second-knower confirm flow; state machine `unverified → machine_consistent → human_verified → cross_validated`; conflicts → admin queue.
- **Freshness:** watcher registry per artifact; source-change → stale-mark → recompile → judge → (if conflict with verified) interview or admin queue (F-FRS-1..3).
- **Admin dashboard + value report** (F-ADM-3): coverage %, open contradictions, change-review inbox, tokens/hours saved; weekly email of the value report to champion.
- **Explorer v1** (read-only): browse artifacts, claim-level provenance deep links (Slack permalinks, GitHub blob#L ranges, Drive doc links; snippets only within viewer's scope, stamped with capture date; `source_unavailable` handling), "suggest a correction" → gap, classic BM25 search over artifacts only.
- **@tacit Slack bot** (F-SRV-5) reusing MCP retrieval path.
- **Zendesk connector.**
- **Down-tiering round 1:** add Fireworks/Together provider to gateway; move `filter`/`extract` to small open model where judge edit-rate <5% on evals; publish $/corpus-GB before/after.
- SOC 2 Type I process start; SSO groundwork.

**P1 exit:** G2 (≥60% of contradictions resolved via loop within 7 days) and G3 (≥70% interview response within 48h) on ≥3 paying accounts.

---

## 7. P2 — Enterprise unlock (Weeks 17–28)

- **VPC/self-hosted SKU:** full pipeline on open weights (vLLM) behind the same gateway interface; Helm charts + Terraform; license keys; opt-in telemetry; deployment runbook (F-SEC-4).
- Database connector scoped to **schema knowledge** (table/field cards, owners, the "why" behind shapes) — explicitly not analytics (PromptQL's turf).
- Cross-repo architecture cards with permission-scoped variants (F-CODE-4).
- **Fine-tune flywheel v1:** export judge-approved (input → approved output) pairs per stage; fine-tune small open models; promote when eval-equal at lower cost.
- SSO/SCIM; audit-log export; SOC 2 Type I complete.
- Gateway-injection integration exploration (LLM-proxy enforcement of tacit_lookup) per adoption strategy.

---

## 8. Data model (core DDL sketch)

```sql
-- sync layer
create table sources (id uuid pk, org_id uuid, kind text, oauth_ref text, scope_config jsonb, status text);
create table sync_items (
  id uuid pk, source_id uuid, external_id text, content_hash text,
  acl jsonb not null,                 -- captured at ingest (F-ING-3)
  raw_ref text, updated_at timestamptz, deleted_at timestamptz,
  unique (source_id, external_id)
);

-- artifacts (PRD §13)
create table artifacts (
  id uuid pk, org_id uuid, type text, schema_version text,
  title text, body_md text,
  verification_state text default 'unverified',
  verified_by text[], verified_at timestamptz,
  valid_from timestamptz, valid_to timestamptz,          -- world time
  recorded_at timestamptz default now(), superseded_at timestamptz,  -- system time
  superseded_by uuid references artifacts(id),
  owner text, permission_scope jsonb not null,           -- {require_all:[...]} (F-SEC-1)
  staleness text default 'fresh', embedding vector(1024)
);
create table claims (id uuid pk, artifact_id uuid, text text, confidence real);
create table provenance (
  id uuid pk, claim_id uuid, source_kind text, external_ref text,
  span int4range, permalink text, captured_at timestamptz,
  status text default 'live'                              -- live | source_unavailable
);

-- gaps & interviews
create table gaps (
  id uuid pk, org_id uuid, kind text,                    -- contradiction|low_confidence|query_miss|drift
  detail jsonb, artifact_ids uuid[], state text default 'open', created_at timestamptz
);
create table interviews (
  id uuid pk, gap_id uuid, knower text, channel text,     -- slack|email|manual
  question text, options jsonb, why_you text,
  sent_at timestamptz, responded_at timestamptz, response jsonb, outcome text
);
create table validation_graph (
  org_id uuid, person text, area text, evidence jsonb,
  response_rate real, accuracy real, last_asked timestamptz,
  primary key (org_id, person, area)
);

-- ops
create table model_calls (id uuid pk, run_id uuid, stage text, provider text, model text,
  in_tokens int, out_tokens int, cost_usd numeric, latency_ms int, edit_rate_signal text);
```

Rate-limit invariant enforced in the interview service, not per-adapter: `count(interviews where knower=X and sent_at > now()-interval '7 days') < org.limit`.

## 9. Claude Code working agreement (CLAUDE.md contents)

- Read `docs/PRD.md` and this plan before any task; requirements are cited by ID (F-CMP-3, G3) in commits.
- Never merge pipeline changes without `pnpm eval` passing; never lower an eval threshold without a founder-approved ADR.
- `packages/schema`, `packages/prompts`, `evals/golden` are propose-only: open a PR, do not self-merge.
- All model calls go through `@tacit/gateway` — a direct SDK import outside that package is a lint error.
- Every agentic harness sets `maxTurns` and a cost ceiling; no unbounded loops.
- Secrets: never log raw source content; quarantine table only referenced by id.
- Prefer boring: Postgres over new infra, functions over frameworks, deletion over abstraction.
- When a task is ambiguous, write the ADR stub first and ask; do not guess on schema, permissions, or rate limits.

## 10. Security & permissions checklist (P0-blocking)

- [ ] ACL captured on every sync item; sync fails closed if ACL unreadable
- [ ] Artifact `permission_scope` = intersection of all contributing sources; enforced in every read path (MCP, explorer, scan report)
- [ ] Permission-trap evals green (zero leaks) on every CI run
- [ ] Secrets scanner in ingest path; quarantined spans never reach model calls or artifacts
- [ ] Per-user MCP auth; org isolation tested with a two-org eval fixture
- [ ] Audit log on every artifact read and every interview sent (F-SEC-2)
- [ ] Read-only OAuth scopes only; scopes displayed at connect time (F-ING-1)

## 11. Budgets, ops, and observability

- Per-org compile budget caps (default $50/initial compile, $5/day incremental) enforced in gateway; hard-stop + admin alert at cap.
- Dashboards: judge edit-rate per stage (down-tiering trigger), $/corpus-GB, coverage %, interview response rate/latency, MCP retention, scan→pilot conversion.
- Weekly prompt/eval review ritual (founder, 1h): read 10 random judged artifacts, 5 escalations, all sent interviews; file prompt issues as eval cases first, prompt edits second.
- Incident runbooks: connector token expiry, webhook backlog, model-provider outage (gateway fallback), permission-leak response (kill-switch: revoke MCP serving org-wide).

## 12. Known build risks

| Risk | Mitigation in plan |
|---|---|
| Eval corpus too easy → false confidence | Add every real design-partner miss back into `evals/` as a case (ratchet) |
| Monorepo-scale compile blowups | Per-repo caps + diff-scoped incremental from Week 4, never full rescans |
| Slack/Drive API quirks eat weeks | Connectors are commodity: copy patterns from Onyx source, don't innovate |
| Interview UX misfires burn partner trust | Manual month first; rubric check on every automated question; hard rate limits from day one of P1 |
| Gateway abstraction leaks (provider quirks) | Contract tests per provider; caching + JSON-mode behaviors covered in evals |
| Founder bottleneck on prompts/schema | Timebox: schema v0 frozen for P0 after Week 3 gate; changes batched weekly |

## 13. Day-1 checklist

1. Register working-name assets (org, domain candidates), start attorney trademark knockout on "Tacit" (classes 9/42, US+EU); hold fallbacks.
2. Create repo from §3 skeleton; write CLAUDE.md; wire CI with a failing `pnpm eval` placeholder (red until Phase 0 done — intentional).
3. Write Northwind Robotics corpus spec (founder, ~2 pages); hand to Claude Code to generate.
4. Anthropic API org + billing caps; Fireworks/Together accounts (dormant until P1); review Anthropic Commercial Terms for resale (pre-contract legal task).
5. Line up 5–10 design-partner conversations now — Week 6 needs three yeses.
