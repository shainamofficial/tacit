# 001 — Raise the eval compile-cost cap from $15 to $20

Date: 2026-09-08

## Context

`evals/golden/thresholds.json` gates every scorecard run on `compile_cost_usd_max`: the model spend for one full compile of the Northwind corpus (2,699 items through every pipeline stage). The $15 value was proposed in Session 3 when the eval runner was built, before any stage existed; the implementation plan asks for the metric but names no number.

Five stages now cost $14.72 live (filter $1.61, extract $2.34, draft $1.90 on Sonnet 5; judge $4.80, contradict discovery $3.5 on Opus 5; verification $0.3 on Sonnet 5). Drift, the last P0 stage, has $0.28 of headroom, which is not a stage budget. Judge and contradict discovery are the two stages the PRD keeps on the frontier model by design (§7.2 steps 4–5), and the plan (§1.3) says not to optimize the model mix before design partners exist.

Holding $15 would mean trading a session of effort/tiering work against a number that was a guess, with no design-partner data on which stages tolerate cheaper models. The judge edit-rate per stage — the plan's actual down-tiering signal — is 31% and has one data point.

## Decision

Raise `compile_cost_usd_max` to $20 for the P0 pipeline (filter → extract → draft → judge → contradict → drift).

The cap stays a hard gate: a change that pushes a full compile over $20 fails the eval like a recall regression does. It is not lowered to make a run pass and not raised again without a new ADR.

## Consequences

- Drift (Session 12) gets a real budget (~$5) instead of forcing effort cuts on judge/discovery to fit.
- The per-stage cost trail in PR descriptions continues; when down-tiering round 1 lands (plan §5 P1: filter/extract to a small open model once judge edit-rate < 5%), the cap should be ratcheted back down in the same PR that shows the saving.
- The per-org runtime budgets in `config/compile-budgets.ts` ($50 initial, $5/day incremental) are unaffected; this cap is the eval's regression tripwire only.
