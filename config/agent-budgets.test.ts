import { describe, expect, it } from 'vitest';
import { AGENT_BUDGETS, agentBudget } from './agent-budgets';

describe('agent budgets (CLAUDE.md non-negotiable #4)', () => {
  it('every agent has a finite, positive turn cap and cost ceiling', () => {
    for (const [name, budget] of Object.entries(AGENT_BUDGETS)) {
      expect(Number.isInteger(budget.maxTurns), `${name}.maxTurns`).toBe(true);
      expect(budget.maxTurns, `${name}.maxTurns`).toBeGreaterThan(0);
      expect(budget.costCeilingUsd, `${name}.costCeilingUsd`).toBeGreaterThan(0);
      expect(Number.isFinite(budget.costCeilingUsd), `${name}.costCeilingUsd`).toBe(true);
    }
  });

  it('pins the archaeologist to the plan (30 turns, $2/run)', () => {
    expect(agentBudget('archaeologist')).toEqual({ maxTurns: 30, costCeilingUsd: 2 });
  });
});
