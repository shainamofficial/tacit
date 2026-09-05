# Tacit × Claude Code — Kickoff Playbook

How to run the first two weeks of the build. Each session below is a real prompt to paste (adapt freely). Principles: one session = one coherent deliverable; always end sessions by running the gates; keep `CLAUDE.md` open and evolving — when Claude Code makes the same mistake twice, the fix is a new line in CLAUDE.md, not a repeated correction.

## Setup (30 minutes, once)

1. Create the repo, copy in `CLAUDE.md`, `docs/PRD.md`, `docs/implementation-plan.md`.
2. Install Claude Code; from repo root run `claude` and confirm it summarizes the project correctly from CLAUDE.md (a good smoke test of the doc).
3. `/permissions`: allow file edits and workspace commands; keep network installs on-ask initially.
4. Set spending expectations: long autonomous runs happen in Phase 0 and pipeline work; use `/cost` at session end until you have a feel.

## Session 1 — Scaffold + CI skeleton

> Read CLAUDE.md and docs/implementation-plan.md §3. Scaffold the pnpm+Turborepo monorepo exactly as specified: all packages and apps as empty-but-compiling workspaces with strict tsconfig, eslint (including the gateway-only-LLM-imports rule as a custom lint), vitest wiring, and a GitHub Actions CI that runs typecheck, test, and `pnpm eval` (eval may be a placeholder that exits 1 with "Phase 0 incomplete" — CI should be red on main until the harness exists; that is intentional). Add docker-compose for Postgres 16 + pgvector and `pnpm db:migrate` tooling with the initial migration from implementation-plan §8. Small commits as you go.

Review checkpoints: the custom lint rule actually fires; migrations run clean; CI is red only on the eval step.

## Session 2 — Northwind corpus generator (Phase 0, part 1)

Write `evals/corpus/SPEC.md` yourself first (~2 pages, founder-owned): company shape, the 8 Slack channels and their personalities, the 3 services in the monorepo, and — critically — the defect answer key: 25 contradictions, 15 drifts, 10 tribal-knowledge gaps, 5 permission traps, each with an id, the sources involved, and the expected detection. Then:

> Read evals/corpus/SPEC.md. Build the Northwind generator: deterministic (seeded) scripts that produce the docs corpus, Slack export JSON, the ticket/macro set, and a real compiling TypeScript monorepo with synthetic git history (150 commits, PR-style messages, CODEOWNERS). Every planted defect from the SPEC answer key must appear verbatim-traceably (emit `evals/corpus/manifest.json` mapping defect id → file/line/message ids). Use the gateway with a $10 budget cap for text generation; cache generations so re-runs are free. Acceptance: `pnpm corpus:build` is reproducible and the manifest covers all 55 defects.

## Session 3 — Eval runner (Phase 0, part 2)

> Implement evals/run.ts per implementation-plan §4: it ingests the Northwind corpus through whatever pipeline stages exist (initially none — score zero), compares against evals/corpus/manifest.json and evals/golden/, and prints the scorecard: contradiction recall/precision, drift recall, permission-trap leaks (any leak = process exit 1), artifact factuality (rubric-judged via gateway, temperature 0), and $/compile. Wire it into CI replacing the placeholder. Add `--stage=` filtering for iteration.

From here CI is your honesty mechanism: main stays red until the pipeline earns green.

## Sessions 4–6 — Gateway, connectors, sync store (Week 1–2 of plan)

One session each: (a) `@tacit/gateway` with routing.yaml, cost logging to `model_calls`, prompt caching, Anthropic provider + contract tests; (b) GitHub App connector + merge webhook; (c) Drive + Slack connectors with ACL capture and content-hash dedup. Each prompt should end with: "acceptance: re-syncing an unchanged corpus performs zero model calls and zero row updates" (the dedup discipline that keeps compile costs sane forever).

## Sessions 7–10 — The compile pipeline (Week 3)

Now the payoff of Phase 0. The loop per stage:

> Implement the `filter` stage per implementation-plan §5 Week 3 using packages/prompts/filter.md (I've drafted it — propose edits as a PR if it underperforms). Run `pnpm eval --stage=filter`, iterate on implementation (not golden files) until stage metrics stabilize, then report the scorecard delta and cost.

Repeat for extract → draft → judge → contradict. Expect the contradiction stage to need several rounds; let Claude Code iterate autonomously against the eval — that's what it's for. Your job is reviewing the judge's escalations and edit-rate report, and tuning prompts via PR.

## Parallel work streams (when you're comfortable)

Run separate sessions/worktrees in parallel safely along package boundaries: one on `apps/admin` (connect flow, scan report UI) while another works `packages/pipeline`. Use `git worktree` + one Claude Code session per worktree; merge via PRs. Avoid two sessions touching `packages/schema` in the same day.

## Weekly founder ritual (1 hour, non-delegable)

- Read 10 random judged artifacts + all judge escalations; file misses as new Northwind defects (the ratchet) before touching prompts.
- Review `model_calls` cost dashboard; check judge edit-rate per stage (your down-tiering signal for P1).
- Prune/extend CLAUDE.md based on the week's corrections.

## Anti-patterns to catch early

- Claude Code "fixing" evals by editing golden files or thresholds → revert, add to CLAUDE.md non-negotiables ledger, restate in session.
- Giant do-everything sessions → deliverables get mushy; keep one artifact per session.
- Accepting pipeline PRs without the scorecard delta in the description → you lose the cost/quality trail that later justifies down-tiering.
- Letting the manual interview month slip because automation is more fun to build — Week 6's Slack DMs are founder work; no session replaces them.
