// Non-negotiable #4 (CLAUDE.md): every Agent SDK harness sets maxTurns and a cost
// ceiling from here. No harness may define its own. Change values via PR with the
// eval scorecard delta; never at a call site.

export interface AgentBudget {
  /** Hard cap on agent turns passed to the Agent SDK harness. */
  readonly maxTurns: number;
  /** Hard cap on spend per run, USD; the harness aborts when reached. */
  readonly costCeilingUsd: number;
}

export const AGENT_BUDGETS = {
  // docs/implementation-plan.md §5 Week 4: "hard caps: 30 turns, $2/run".
  archaeologist: { maxTurns: 30, costCeilingUsd: 2 },
  // Judge escalation path: a bounded second look at one artifact, not a research task.
  judgeEscalation: { maxTurns: 10, costCeilingUsd: 1 },
  // P1 interviewer: formulate one question from one gap. Tighten once real data exists.
  interviewer: { maxTurns: 8, costCeilingUsd: 0.5 },
} as const satisfies Record<string, AgentBudget>;

export type AgentName = keyof typeof AGENT_BUDGETS;

export function agentBudget(name: AgentName): AgentBudget {
  return AGENT_BUDGETS[name];
}
