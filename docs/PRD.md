# PRD: Company Brain — Self-Maintaining, Human-Validated Organizational Knowledge

**Version:** 0.1 (draft for design partners)
**Owner:** Shainam
**Status:** Pre-MVP

---

## 1. Summary

Company Brain ingests an organization's knowledge sources (Slack, Google Drive, Zendesk, Git repositories, databases), distills them into compact, structured, provenance-stamped artifacts, and serves them over MCP to the AI tools employees already use (Claude, Claude Code, Cursor, Copilot, internal agents).

Unlike search products (index and retrieve) and memory layers (store and recall), the Brain **actively maintains its own accuracy**: it detects contradictions and gaps, identifies the employees most likely to know the answer, interviews them through Slack with single-tap questions, cross-validates answers with a second knower, and writes verified facts back with provenance and validity metadata. The company's codebase serves as ground truth, enabling code-vs-docs drift detection.

**One-line positioning:** The only knowledge base that gets more accurate over time instead of less.

## 2. Problem

1. **Context is re-derived constantly.** Every employee's AI session rebuilds company context from scratch — retrieval returns ten semi-relevant chunks and the model burns tokens reconciling them. Cost and quality both suffer.
2. **Knowledge rots.** Docs contradict each other, macros describe behavior the code no longer has, onboarding guides reference archived channels. Existing tools (wikis, Guru, enterprise search) rely on humans to notice and fix decay. They don't.
3. **AI tools confidently repeat stale facts.** As AI usage grows, the cost of wrong context grows with it. This problem gets worse with model adoption, not better.
4. **Tribal knowledge is unwritten.** The "why" behind decisions lives in PR threads, Slack scrollback, and people's heads. No passive system can capture it — someone has to ask.

## 3. Goals and non-goals

### Goals (12-month)
- G1. An employee's AI tool answers company-specific questions correctly, with sources and verification status, using ≤500 tokens of injected context in the common case.
- G2. The Brain detects contradictions and staleness automatically and resolves ≥60% of them through the human interview loop within 7 days.
- G3. Employees answer ≥70% of interview questions within 48 hours (proof that the interview UX is respectful enough to work).
- G4. A prospect can connect two sources read-only and receive a contradiction-scan report within 1 hour, unassisted.
- G5. Serve everything over MCP; zero new UI for everyday employees.

### Non-goals (explicitly out of scope for v1)
- NG1. General enterprise search over raw documents (Glean's territory; we serve compiled artifacts, not a search box).
- NG2. Per-user personalization/memory of individual conversations (Supermemory/Mem0 territory).
- NG3. Writing net-new long-form documentation from scratch.
- NG4. Non-technical verticals; consumer.
- NG5. Real-time chat/copilot UI of our own.

## 4. Target customer and personas

**Beachhead:** 50–500 person AI-forward technical companies (dev-tools, SaaS with engineering-heavy orgs) with heavy Claude/Cursor adoption, a card-swiping champion (CTO, Head of Eng/Ops), and visible doc-vs-code drift.

| Persona | Role in product | Success looks like |
|---|---|---|
| **Champion/Admin** (CTO, Head of Ops) | Buys, connects sources, sets interview budget, reviews weekly | 10 min/week; renewal-ready value report |
| **Everyday employee** | Never "uses" the product; their AI tools get better | Doesn't know the Brain exists, notices answers improved |
| **Knower** (SME) | Answers 1–2 targeted questions/week, one tap each | Feels respected; sees "Verified by <name>" attribution |
| **Security reviewer** | Gates the deal | Read-only scopes, permission inheritance, VPC option |

## 5. Product principles

1. **No new UI for employees.** The Brain lives inside existing AI tools via MCP and inside Slack. The admin dashboard is the only screen we own.
2. **Every answer carries provenance.** Source links, verification status, verifier name, validity timestamps. An unsourced answer is a bug.
3. **Code is ground truth.** When code and docs conflict, code wins and the doc is flagged wrong — no hedging.
4. **Respect the knower.** Hard rate limits, one-tap answers, always show why they were asked. One dumb question costs more than ten unanswered gaps.
5. **Never delete truth; supersede it.** Facts get validity intervals (bi-temporal), so "what was the policy in Q1" stays answerable.
6. **Permissions are inherited, never invented.** An employee can never retrieve an artifact derived from sources they cannot access.
7. **Frontier intelligence only where judgment lives.** Bulk work runs on open-weight models; frontier models judge, discover contradictions, and talk to humans.

## 6. Core concepts and vocabulary

- **Artifact** — the atomic unit of compiled knowledge. Types: `entity_card`, `decision_record`, `process_doc`, `service_card`, `api_surface`, `glossary_entry`, `qa_fact`.
- **Provenance** — links from every artifact claim to source spans (doc ID + range, Slack permalink, commit/PR, ticket ID).
- **Verification state** — `unverified` → `machine_consistent` → `human_verified` (single knower) → `cross_validated` (two knowers). Each state carries actor + timestamp.
- **Validity interval** — bi-temporal timestamps: `valid_from`/`valid_to` (world time) and `recorded_at`/`superseded_at` (system time).
- **Gap** — a detected unknown: contradiction, low-confidence artifact, or query-miss.
- **Validation graph** — per-person map of demonstrated knowledge areas, response rate, confirmation accuracy; drives interview routing.
- **Interview** — a single, specific, one-tap-answerable question routed to a knower via Slack.
- **Compile** — the offline distillation run converting synced sources into artifacts.

---

## 7. Functional specification

### 7.1 Ingestion layer (P0)

**Sources at launch:** Slack, Google Drive, GitHub. (Zendesk P1; databases P2.)

Requirements:
- F-ING-1. Read-only OAuth per source; minimal scopes; scopes listed in UI at connect time.
- F-ING-2. Initial backfill + incremental sync. Drive/Slack via webhooks/polling deltas; GitHub via webhook on merge to main (never full rescans).
- F-ING-3. Permission metadata captured at ingest for every item (Drive ACLs, Slack channel membership, repo access) and stored alongside content.
- F-ING-4. Admin scoping: include/exclude channels, folders, repos before first compile.
- F-ING-5. Secrets scanning at ingest (regex + entropy) — flagged content never reaches a model call or artifact.
- F-ING-6. Dedup/diff store: unchanged content is never re-processed (content-hash per item and per chunk).
- Build note: evaluate Onyx connectors / source APIs directly; connectors are commodity — do not innovate here.

### 7.2 Compile pipeline (distillation) (P0) — *this is the product*

A deterministic, queue-based pipeline (Temporal or Postgres-backed jobs) with LLM steps, **not** one big agent loop.

Stages and default model tier:
1. **Filter/classify** (small open model): signal vs. noise; entity linking; "already covered?" checks.
2. **Extract** (small open model): schema-constrained JSON extraction (dates, owners, fields).
3. **Draft** (mid open model, 70B-class): first-pass summaries; draft artifacts from filtered sources.
4. **Judge** (frontier Claude): review draft against sources → approve / edit / escalate. Judge edit-rate per stage is logged as the live quality signal and the trigger for re-tiering.
5. **Contradiction discovery** (frontier Claude): cross-source conflict finding. Pairwise "does X contradict Y" verification runs mid-tier; *discovery* of non-obvious conflicts stays frontier.

Requirements:
- F-CMP-1. Every artifact conforms to a versioned JSON schema with provenance spans, confidence, verification state, validity interval, owner, permission scope.
- F-CMP-2. Compile is idempotent and resumable; per-repo/per-source budget caps and turn limits on any agentic step.
- F-CMP-3. Model gateway (LiteLLM-style) with per-stage routing config, fallbacks, cost/latency logging. No direct model calls anywhere in the codebase.
- F-CMP-4. Golden-set evals per stage (synthetic company corpus with planted contradictions); CI fails on regression. Built *before* the pipeline.
- F-CMP-5. Aggressive caching: prompt caching on frontier calls; never re-summarize unchanged content.

### 7.3 Codebase layer (P0 for demo, deepens in P1)

- F-CODE-1. Artifacts: `service_card` (purpose, owners, dependencies, invariants, gotchas), `api_surface`, decision records mined from PR descriptions/review threads, incident-to-code links.
- F-CODE-2. CI-triggered incremental pass on merge: map diff → affected artifacts → mark stale or auto-update; judge reviews anything touching a `human_verified` fact.
- F-CODE-3. **Drift detection:** compare code-derived facts against docs/macros/artifacts; code wins; produce a diff-linked finding. This powers the sales demo.
- F-CODE-4. Cross-repo architecture cards served only to users with access to *all* underlying repos (or generated in permission-scoped variants).
- F-CODE-5. The "codebase archaeologist" (frontier, Agent SDK harness): trace a decision from code → PR → linked Slack thread; used for high-value cards and gap resolution, bounded by budget caps.

### 7.4 Serving layer — MCP (P0)

- F-SRV-1. MCP server exposing tiered retrieval tools: (a) `lookup` — index/summary, ~100 tokens; (b) `get_artifact` — full card, ~300–600 tokens; (c) `get_sources` — raw source spans, on explicit request only.
- F-SRV-2. Every response includes verification state, verifier, date, and source links. Format optimized for model consumption (structured, terse).
- F-SRV-3. Per-user auth on the MCP connection; all retrieval permission-filtered at query time (query-miss ≠ permission-miss in logs, identical to the user).
- F-SRV-4. Query-miss logging feeds gap detection (F-GAP-1c).
- F-SRV-5. `@brain` Slack bot as the non-MCP access path (P1).
- F-SRV-6. Model-agnostic: works identically from Claude, Cursor, Copilot, or any MCP client.

### 7.5 Gap detection and interview loop (P0-lite, full in P1) — *the moat*

Gap sources:
- F-GAP-1a. Compile-time contradictions (two sources disagree).
- F-GAP-1b. Low-confidence artifacts (single weak source).
- F-GAP-1c. Query-time misses (asked, couldn't answer).
- F-GAP-1d. Code drift findings (F-CODE-3).

Interview mechanics:
- F-INT-1. Knower selection via validation graph: doc edit history, Slack thread participation, CODEOWNERS/blame, prior confirmation accuracy. Show the "why you" reason in every question.
- F-INT-2. Question formulation (frontier): single, specific, one-tap-answerable. Buttons: direct options, `It's complicated →` (thread; Brain drafts artifact from the reply and shows it back for approval), `Not my area →` (updates routing graph).
- F-INT-3. Cross-validation: second knower gets a one-tap confirm. On confirm → `cross_validated`; on conflict → escalate to admin queue.
- F-INT-4. **Hard rate limits:** default max 2 questions/person/week, admin-tunable; global org budget; quiet hours; no repeats of ignored questions within 30 days.
- F-INT-5. Attribution: served answers display "Verified by <name>, <date>."
- F-INT-6. All interview traffic logged to the validation graph (response rate, latency, accuracy).
- MVP note: in design-partner phase, the founder manually plays the interview agent over Slack for ≥1 month before automating (validates thesis G3 cheaply).

### 7.6 Freshness and invalidation (P0)

- F-FRS-1. Source change → dependency map → affected artifacts marked `stale`, never silently rewritten if `human_verified`.
- F-FRS-2. Superseded facts get `valid_to`/`superseded_at` set; never deleted. Historical queries remain answerable.
- F-FRS-3. Staleness triggers re-compile of affected artifacts; conflicts with verified facts route to the interview loop or admin queue.

### 7.7 Admin experience (P0-lite)

- F-ADM-1. Connect flow: OAuth per source, scope picker, permission-mapping review ("who can see what — approve").
- F-ADM-2. Interview budget slider (the social-risk control).
- F-ADM-3. Weekly dashboard: coverage % (confident answers / queries), open contradictions, change-review inbox, value report (queries answered, est. tokens/hours saved). Designed for a 10-minute weekly ritual.
- F-ADM-4. Contradiction-scan report (the first-hour experience): findings with source links + one headline number (est. hours/week of re-answered questions). Generated unassisted within 1 hour of connecting 2 sources.

### 7.8 Security, permissions, deployment

- F-SEC-1. Artifact-level permission scopes computed from source ACL intersection; enforced at serve time. (An artifact synthesized from N sources is visible only to users with access to all N, or is generated in scoped variants.)
- F-SEC-2. Audit log of every retrieval and every interview.
- F-SEC-3. SSO/SCIM (P1); SOC 2 track started early (P1).
- F-SEC-4. **VPC/self-hosted tier (P1–P2):** full pipeline on open-weight models behind the gateway; Helm/Terraform packaging; license keys; opt-in telemetry. Unlocks code-heavy, security-sensitive buyers. Architecture must not preclude this from day one.

---

## 8. Architecture overview

```
Sources (Slack / Drive / GitHub / Zendesk)
      │  read-only OAuth, webhooks, deltas, ACL capture
      ▼
Sync store (raw items + content hashes + permissions)
      │
      ▼
Compile pipeline (queue + workers; deterministic, resumable)
  filter → extract → draft → JUDGE → contradiction discovery
  [model gateway routes each stage: small/mid open-weight ↔ frontier Claude]
      │                              │
      ▼                              ▼
Artifact store (Postgres + pgvector)   Gap queue
  schema-versioned, bi-temporal,           │
  provenance, permission scopes            ▼
      │                        Interview agent (Agent SDK, frontier)
      │                          Slack one-tap Qs → knower → cross-validate
      │                              │
      │◄─────── verified writes ─────┘
      ▼
MCP server (tiered retrieval, per-user auth, permission filter)
      ▼
Employee AI tools (Claude, Claude Code, Cursor, Copilot) + @brain Slack bot
```

**Harness split:** the compile pipeline is boring orchestrated code with LLM calls; Claude Agent SDK is used only where genuine agency pays — the interview agent, the judge escalations, and the codebase archaeologist — each with turn caps and spend ceilings.

**Build tooling:** Claude Code as the engineering team. Distillation prompts, artifact schemas, and gap heuristics are versioned, eval-gated assets owned by the founder; plumbing is delegated.

## 9. Phasing

### P0 — Contradiction scan + compiled context (weeks 1–6)
Slack + Drive + GitHub read-only sync · compile pipeline (frontier-first behind gateway) · artifact store · MCP server with tiered retrieval · drift detection · scan report · minimal admin flow · founder-manual interview loop.
**Exit criteria:** G4 met on 3 design partners; ≥1 partner's engineers keep the MCP connection enabled voluntarily after 2 weeks.

### P1 — The loop closes (weeks 7–16)
Automated interview agent + cross-validation + validation graph · freshness/invalidation on verified facts · admin dashboard + value report · @brain bot · Zendesk connector · down-tier pipeline stages per judge edit-rate · SOC 2 start.
**Exit criteria:** G2, G3 hit on ≥3 paying accounts.

### P2 — Enterprise unlock (weeks 17–28)
VPC/self-hosted SKU on open weights · SSO/SCIM · database connector · cross-repo architecture cards · fine-tune small models on judge-approved outputs (cost flywheel).

## 10. Success metrics

| Metric | Target | Why it matters |
|---|---|---|
| Coverage: confident-answer rate on employee queries | 60% → 80% by month 3 per account | The product works |
| Interview response rate / median latency | ≥70% within 48h | The moat works (social viability) |
| Contradictions resolved via loop within 7 days | ≥60% | Self-maintenance is real |
| Judge edit-rate per pipeline stage | trending ↓ per stage | Cost flywheel + quality signal |
| Median injected context per answered query | ≤500 tokens | Token-savings claim is true |
| Verified artifacts per account (cumulative) | growing monthly | Switching cost / moat depth |
| Weekly champion dashboard visit + value report forwarded | qualitative | Renewal predictor |
| Scan → paid conversion | ≥25% of scans → pilot | GTM engine works |

## 11. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Employees ignore the interview bot (thesis-killer) | High | Founder-manual month before automating; hard rate limits; one-tap UX; "why you" transparency; attribution reward |
| Permission leak via synthesized artifact | High | ACL-intersection scoping in schema from day 1; audit log; red-team eval set |
| One confidently wrong served answer nukes trust | High | Provenance on every answer; verification states surfaced; judge layer; conservative confidence thresholds |
| Glean/Dust/Supermemory move up- or down-stack | Med | Speed; validation-graph data compounding; verified-knowledge switching costs |
| Huge cheap contexts erode token-savings pitch | Med | Anchor positioning on accuracy/self-maintenance, not tokens |
| Frontier API COGS at scale | Med | Gateway + tiering from day 1; judge edit-rate-driven down-tiering; fine-tune flywheel (P2) |
| Monorepo scale blows compile budgets | Med | Per-repo caps; diff-scoped passes; dedup discipline |
| Secrets in repos reach model calls | High | Ingest-time scanning; deny-by-default on flagged spans |

## 12. Open questions

1. Pricing model: per-seat vs. per-source vs. platform fee + usage? (Leaning platform fee + seats; token pass-through confuses the value story.)
2. Artifact schema v1: how much structure before design-partner data validates it? (Ship minimal: 4 artifact types in P0.)
3. Slack-first interviews — do we need email fallback for non-Slack orgs in beachhead? (Assume no for v1.)
4. How much of the scan report is free vs. gated? (Free scan is the wedge; gate remediation.)
5. Zendesk vs. Linear/Jira as the fourth connector — which does the beachhead actually pull for?
6. Claude Agent SDK commercial terms review before first paid contract (legal task, pre-P1).

## 13. Appendix: Artifact schema sketch (v0)

```json
{
  "id": "art_9f3a",
  "type": "entity_card | decision_record | process_doc | service_card | api_surface | glossary_entry | qa_fact",
  "schema_version": "0.3",
  "title": "Refund policy — annual plans",
  "body_md": "Refunds: 14 days (monthly), 30 days (annual). Enterprise: per-contract. …",
  "claims": [
    {
      "text": "Annual-plan refund window is 30 days",
      "provenance": [
        {"source": "gdrive", "doc_id": "1AbC…", "span": [1204, 1288]},
        {"source": "slack", "permalink": "https://…"}
      ],
      "confidence": 0.92
    }
  ],
  "verification": {
    "state": "cross_validated",
    "verified_by": ["priya@co", "sam@co"],
    "verified_at": "2026-05-14T09:22:00Z"
  },
  "validity": {
    "valid_from": "2026-01-10",
    "valid_to": null,
    "recorded_at": "2026-05-14",
    "superseded_at": null
  },
  "owner": "priya@co",
  "permission_scope": {"require_all": ["gdrive:doc:1AbC…", "slack:channel:C024…"]},
  "staleness": {"state": "fresh", "watch": ["gdrive:doc:1AbC…", "repo:billing-service:src/refunds/*"]}
}
```
