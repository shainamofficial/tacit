# Tacit

**Compiled, human-validated organizational knowledge — served into every AI tool your company already uses.**

Tacit syncs Slack, Google Drive, and GitHub (read-only), compiles them into compact verified artifacts with provenance and bi-temporal validity, detects contradictions and code-vs-docs drift, routes gaps to the right experts through one-tap Slack interviews, and serves verified truth over MCP.

> RAG assumes your documents are right. We assume they disagree, drift, and have gaps — because they do.

## Status

Pre-P0. Docs-first repo: the product spec and build plan live here; the code is scaffolded by Claude Code following `docs/claude-code-playbook.md`.

## Documents

| Doc | Purpose |
|---|---|
| [`CLAUDE.md`](./CLAUDE.md) | Working agreement for Claude Code — non-negotiables, ownership boundaries, style |
| [`docs/PRD.md`](./docs/PRD.md) | Product requirements: goals, functional spec (F-*), artifact schema, metrics, risks |
| [`docs/implementation-plan.md`](./docs/implementation-plan.md) | Tech stack, repo structure, week-by-week P0→P2 build order, DDL, security checklist |
| [`docs/claude-code-playbook.md`](./docs/claude-code-playbook.md) | Session-by-session kickoff prompts and founder rituals |
| `docs/decisions/` | ADRs — one per irreversible decision |

## Build order (short version)

1. **Phase 0:** Northwind Robotics synthetic corpus + eval harness. CI stays red until the pipeline earns green.
2. **P0 (wk 1–6):** connectors → compile pipeline → drift detection → MCP server → contradiction-scan report. Founder runs the interview loop manually.
3. **P1 (wk 7–16):** automated Slack/email interviews, validation graph, freshness, dashboard.
4. **P2 (wk 17–28):** VPC/self-hosted SKU on open weights, DB connector, fine-tune flywheel.

## Getting started (founder)

```bash
git clone https://github.com/shainamofficial/tacit && cd tacit
# open in Claude Code (desktop app → Code tab → this folder)
# paste Session 1 from docs/claude-code-playbook.md
```
