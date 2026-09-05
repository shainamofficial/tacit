// docs/implementation-plan.md §11: per-org compile budget caps enforced in the gateway;
// hard-stop plus admin alert at cap (F-CMP-2). Orgs can lower these via org settings.

export const COMPILE_BUDGETS = {
  /** Default cap for an org's first full compile, USD. */
  initialCompileUsd: 50,
  /** Default daily cap for incremental compiles, USD. */
  incrementalPerDayUsd: 5,
} as const;
