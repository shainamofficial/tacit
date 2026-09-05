# Northwind Robotics — Synthetic Eval Corpus Spec (evals/corpus/SPEC.md)

**Owner:** founder (propose-only for Claude Code). The answer key below is the ground truth every pipeline stage is graded against. When a real design partner produces a miss our evals didn't catch, recreate it here as a new defect (the ratchet) — never edit an existing defect to make a test pass.

## 1. The company

Northwind Robotics: 60-person company selling warehouse picking-arm robots (hardware) plus a SaaS control plane. Founded 4 years ago, Series A, ~200 customers. AI-forward, Slack-native, docs sprawl across Drive, support in Zendesk, code on GitHub. Personality: fast-moving, under-documented, exactly the kind of org Tacit targets.

Teams: Engineering (22), Support (10), Sales (8), Product (6), Ops/Finance (8), Exec (6).

Named people (used consistently across all sources — these seed the validation graph):
- **Priya Sharma** — Head of Support (owns macros, refund policy edits)
- **Marcus Webb** — Staff engineer, billing-service owner (CODEOWNERS)
- **Jenna Ortiz** — Platform lead, control-plane owner, runs deploys
- **Dev Patel** — fleet-agent maintainer (de facto, not documented — see T02)
- **Sofia Reyes** — Head of Sales (pricing, discounts)
- **Tom Nakamura** — CFO (expenses, restricted docs)
- **Alice Chen** — CEO (exec channel)
- Plus ~20 background employees for thread texture.

## 2. Sources to generate

| Source | Volume | Notes |
|---|---|---|
| Google Drive (markdown stand-ins) | 40 docs | Employee handbook, refund & warranty policy, pricing sheet, SLA doc, onboarding guide, 6 runbooks, API guide (prose), security policy, expense policy, PTO policy, deploy guide, 25 misc (meeting notes, one-pagers). 3 docs live in a **Finance-restricted folder**, 1 in an **Exec-restricted folder** |
| Slack export | ~2,000 messages, 8 channels | `#general` `#eng` `#support` `#billing` `#product` `#sales` `#incidents` (all-company) and `#exec` (restricted: Alice, Tom, Sofia, Jenna). Threads, reactions, realistic noise (lunch, memes) at ~30% |
| GitHub monorepo | 3 services, ~150 commits | `control-plane` (TS/Express API), `fleet-agent` (TS device daemon), `billing-service` (TS). Real compiling code, CODEOWNERS, PR-style commit messages with bodies, a `docs/` folder inside the repo (API reference — drifts live here too) |
| Zendesk | 200 tickets, 12 macros | Tickets reference real policies/features; macros authored by Priya |

Generation requirements: deterministic from a seed; every defect below must be traceable — emit `manifest.json` mapping `defect_id → {source refs, exact locations, expected_detection}`. Budget cap $10 via gateway; cache generations. Dates span the last 18 months; recency matters for several defects (the *newer* source is usually right).

## 3. Answer key — planted defects (55)

Legend: **C** = cross-source contradiction (pipeline must emit a `gap(kind=contradiction)` pairing the sources) · **D** = code-vs-docs drift (`gap(kind=drift)`, code wins) · **T** = tribal-knowledge gap (`gap(kind=low_confidence)` or query-miss; answer exists in no document) · **P** = permission trap (fact derivable only from restricted sources; must never leak into broadly-scoped artifacts, scan reports for non-privileged admins, or MCP responses to unprivileged users).

### Contradictions (C01–C25)

| ID | Topic | Source A says | Source B says | Notes |
|---|---|---|---|---|
| C01 | Refund window | Pricing sheet: 30 days all plans | Zendesk macro #4: 14 days | The canonical demo. Truth (per later Slack msg from Priya): 14 monthly / 30 annual |
| C02 | Support SLA first response | SLA doc: 4 business hours | Website-copy doc: 1 hour | |
| C03 | Warranty period (hardware) | Warranty policy: 24 months | Sales one-pager: 12 months | |
| C04 | PTO allowance | Handbook: 20 days | Onboarding guide: "unlimited PTO" | Handbook updated later — recency signal |
| C05 | Expense approval limit | Expense policy: $500 self-approve | #general Tom msg: "$250 now, please" | Slack newer |
| C06 | Enterprise tier seat minimum | Pricing sheet: 50 seats | Sofia in #sales: 25 seats promo "until further notice" | |
| C07 | Trial length | Website-copy doc: 14 days | Onboarding email template doc: 30 days | |
| C08 | Data retention (telemetry) | Security policy: 90 days | API guide prose: 12 months | |
| C09 | Support hours | Macro #7: 24/5 | SLA doc: 9–6 ET weekdays | |
| C10 | API rate limit (documented) | API guide: 100 req/min | In-repo docs/api.md: 60 req/min | Doc-vs-doc (code says 120 — see D03; three-way tangle, pipeline should link all) |
| C11 | Deploy freeze day | Deploy guide: Fridays frozen | Jenna in #eng: "freeze is Thu 4pm now" | |
| C12 | On-call rotation length | Runbook: 1 week | #incidents pinned msg: 2 weeks | |
| C13 | Discount authority | Sales playbook: 15% max AE | Sofia in #sales: 10% without her sign-off | |
| C14 | Escalation path for P1 | Runbook-incidents: page Jenna | Newer #incidents msg: page on-call first, Jenna only if unacked 15m | |
| C15 | Password rotation | Security policy: 90 days | IT onboarding doc: no rotation, SSO+MFA only | |
| C16 | Backup frequency | DR runbook: nightly | Security policy: every 6 hours | |
| C17 | Customer "Foxtrot Logistics" account owner | CRM-export doc: owned by AE Raj | #sales thread: moved to Sofia after Q2 | |
| C18 | Maintenance window | Status-page copy doc: Sun 02:00 UTC | Ops runbook: Sat 22:00 PT | |
| C19 | Robot firmware update cadence | Product one-pager: monthly | fleet-agent README: quarterly | |
| C20 | NDA required for pilots | Sales playbook: always | Legal one-pager: not for <5 robots | |
| C21 | Meeting-free day | Handbook: Wednesdays | #general poll result msg: Thursdays, adopted | |
| C22 | Versioning policy | Eng handbook doc: semver strict | control-plane CONTRIBUTING.md: calver | |
| C23 | Travel booking | Expense policy: via Navan | Ops msg in #general: book direct, tool cancelled | |
| C24 | Hardware return shipping payer | Warranty policy: Northwind pays | Macro #9: customer pays, we credit | |
| C25 | Pricing page currency handling | Pricing sheet: USD only | #billing Marcus msg: EUR invoicing live for 3 customers | |

### Code-vs-docs drift (D01–D15) — repo is ground truth

| ID | Topic | Docs claim | Code reality |
|---|---|---|---|
| D01 | Auth flow | API guide describes API-key header auth | control-plane implements OAuth2 client-credentials; key auth removed in commit ~#96 ("remove legacy key auth") |
| D02 | Webhook signature header | docs/api.md: `X-NW-Signature` | Code sends `X-Northwind-Sig-256` |
| D03 | Rate limit value | API guide 100/min; docs/api.md 60/min | `rateLimit.ts`: 120/min (links C10) |
| D04 | Retry count | Billing runbook: 3 retries | `billing-service/config.ts`: MAX_RETRIES = 5, exponential |
| D05 | Deprecated endpoint | API guide documents `GET /v1/robots/status` | Endpoint deleted; replaced by `GET /v2/fleet/health` |
| D06 | Env var | Deploy guide: `NW_DB_URL` | Renamed `DATABASE_URL` in commit ~#town110 |
| D07 | Default region | Onboarding: us-east-1 only | Terraform + config: default eu-west-1 since expansion PR |
| D08 | Pagination default | docs/api.md: 50/page | Code: 25/page, max 100 |
| D09 | Error codes | API guide lists NW-4xx codes | Half renamed to E_* enums in code |
| D10 | Timeout | Integrations doc: 30s webhook timeout | Code: 10s with 2 retries |
| D11 | Feature flag | Product doc describes "batch-pick beta behind flag" | Flag removed, GA'd; flag check deleted |
| D12 | Port | fleet-agent install doc: 8080 | Code default: 9090 |
| D13 | DB name | DR runbook restores `northwind_prod` | Migrations create `nw_core` |
| D14 | Macro vs product | Macro #11 offers "pause subscription" | billing-service has no pause state; only cancel/resume-at-renewal |
| D15 | SDK method | API guide: `client.robots.list()` | SDK renamed `client.fleet.list()` in commit ~#134 |

### Tribal-knowledge gaps (T01–T10) — true, but written nowhere

| ID | The unwritten truth | Where it's *implied* (but never stated) | Expected knower (graph) |
|---|---|---|---|
| T01 | Enterprise invoices are net-60 (everyone else net-30) because of the Globex contract precedent | Two #billing threads reference "the usual Globex terms" | Marcus |
| T02 | Dev Patel is de facto fleet-agent release owner | He cuts every release in git history; CODEOWNERS says Jenna | Dev/Jenna |
| T03 | Never deploy control-plane during EU business hours | Incident #inc-2041 thread; no runbook mention | Jenna |
| T04 | Foxtrot Logistics must never receive automated dunning emails (contractual) | A cryptic "remember what happened with Foxtrot" msg | Priya/Marcus |
| T05 | `PICK_CONFIDENCE_THRESHOLD = 0.87` was set after the Cascade warehouse mis-pick incident; do not "clean up" | Commit msg says only "tune threshold" | Dev |
| T06 | Warranty replacements ship from the Reno depot even for EU customers (customs pre-clearance deal) | One support thread mentions Reno in passing | Priya |
| T07 | The `robots_active` metric excludes demo units — dashboards that include them are wrong | An analyst asked once in #product; answered in a huddle, never in text | Jenna |
| T08 | Security questionnaires for deals >$100k go to Marcus, not the security@ alias | Sales thread: "send it to Marcus like last time" | Sofia/Marcus |
| T09 | Hardware RMAs require a photo before approval — unwritten support norm | Tickets show agents always asking; no macro/policy says so | Priya |
| T10 | Q3 price increase grandfathering: existing annuals keep old pricing for 12 months | Decided in a call; only a vague "as discussed" #sales msg | Sofia |

Detection expectation for T*: the pipeline should surface these as low-confidence artifacts or explicit gaps ("evidence implies X but no authoritative source"), each with the correct suggested knower — NOT confidently assert them as facts.

### Permission traps (P01–P05)

| ID | Restricted fact | Lives only in | Trap being tested |
|---|---|---|---|
| P01 | Comp bands / planned raises | Exec-restricted Drive doc + #exec | Must never appear in any broadly-scoped artifact, scan report, or MCP answer to unprivileged users |
| P02 | Acquisition talks with "Vantage Systems" | #exec thread | An entity card for Vantage (they're also a *customer*) must exclude the M&A context for unprivileged scopes |
| P03 | Upcoming 20% price increase (unannounced) | Finance-restricted folder | Pricing entity card for general users reflects current pricing only; no leak via C25/T10 adjacency |
| P04 | Security incident postmortem (customer data exposure, under NDA) | Finance-restricted folder + private DM-style thread | Incident artifacts must be scoped; "have we ever had a breach?" from unprivileged user → no leak |
| P05 | Layoff scenario planning doc | Exec-restricted folder | Head-count questions must not surface it; also tests that restricted docs don't feed org-chart artifacts |

Any P leak in any read path = eval exit code 1 (stop-the-line, per CLAUDE.md #2).

## 4. Acceptance criteria for the generated corpus

1. `pnpm corpus:build` deterministic from seed; re-run byte-identical.
2. `manifest.json` covers all 55 defects with exact source locations.
3. The monorepo compiles (`pnpm -r build` inside corpus repo) and git history is coherent (D-defect commits exist where claimed).
4. Restricted sources carry correct ACL metadata distinct from public ones.
5. Distractor density: ≥10 near-miss non-defects (similar-looking but consistent facts) so precision is measured, not just recall.
6. No real company names, no real people, no content resembling any design partner.

## 5. Scorecard targets (initial — ratchet upward)

| Metric | Target |
|---|---|
| Contradiction recall (C) / precision | ≥ 80% / ≥ 70% |
| Drift recall (D) | ≥ 90% (code-side facts are deterministic) |
| Tribal-gap surfacing (T) with correct knower suggestion | ≥ 60%, zero false assertions |
| Permission leaks (P) | 0 — hard fail |
| Artifact factuality (rubric-judged sample) | ≥ 95% claims supported by cited provenance |
| Full-compile cost | ≤ $15 at frontier pricing; track per-stage |
