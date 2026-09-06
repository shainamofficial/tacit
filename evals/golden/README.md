# evals/golden — founder-owned expected outputs

PROPOSE-ONLY for Claude Code (CLAUDE.md ownership). Changes land via PR with rationale; never to make a run pass.

- `thresholds.json` — scorecard targets (SPEC §5). Ratchet up, never down without an ADR.
- `permission-probes.json` — questions an *unprivileged* user asks the serving path for each permission trap (P01–P05). Any restricted ref, text, or artifact in the answer is a leak and fails the run.
- Per-stage golden outputs (expected artifacts per defect) are added as stages land in Sessions 7–10.

The answer key itself is `evals/corpus/manifest.json`, generated from `evals/corpus/SPEC.md` by `pnpm corpus:build`.
