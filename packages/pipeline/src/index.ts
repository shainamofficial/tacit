// @tacit/pipeline — pg-boss compile stages: filter -> extract -> draft -> judge -> contradict;
// idempotent, resumable, budget-capped (F-CMP-2). Stage implementations land in Sessions 7-10.
// The eval contract (what stages must produce to be graded) is here already.
export * from './contract';
