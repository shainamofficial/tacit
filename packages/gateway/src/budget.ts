// Per-run spend ledger with a hard stop (F-CMP-2, plan §11). In-process for
// P0; the pipeline_runs.spent_usd column is the durable record once the
// pg-boss workers land (Week 3).

export class BudgetExceededError extends Error {
  constructor(
    readonly runId: string,
    readonly spentUsd: number,
    readonly budgetUsd: number,
  ) {
    super(`run ${runId} has spent $${spentUsd.toFixed(4)} of its $${budgetUsd.toFixed(2)} budget; hard stop`);
    this.name = 'BudgetExceededError';
  }
}

export class SpendLedger {
  private readonly spent = new Map<string, number>();

  add(runId: string, usd: number): number {
    const next = (this.spent.get(runId) ?? 0) + usd;
    this.spent.set(runId, next);
    return next;
  }

  get(runId: string): number {
    return this.spent.get(runId) ?? 0;
  }

  /** Throws before a call is made if the run has already reached its cap. */
  assertWithin(runId: string, budgetUsd: number): void {
    const spent = this.get(runId);
    if (spent >= budgetUsd) throw new BudgetExceededError(runId, spent, budgetUsd);
  }
}
