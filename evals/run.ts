// `pnpm eval [--stage=<filter|extract|draft|judge|contradict>]`
//
// PLACEHOLDER. Exits 1 on purpose until Phase 0 (docs/implementation-plan.md §4)
// delivers the Northwind corpus (Session 2) and the real runner (Session 3).
// CI on main is expected to be red on this step until then: evals gate
// everything (CLAUDE.md non-negotiable #1, F-CMP-4), and a green placeholder
// would be a lie.

const stageArg = process.argv.find((arg) => arg.startsWith('--stage='));
const stage = stageArg?.slice('--stage='.length);

console.error(
  'Phase 0 incomplete: the Northwind corpus and golden set are not built yet' +
    (stage ? ` (requested stage: ${stage})` : '') +
    '. See docs/implementation-plan.md §4 and docs/claude-code-playbook.md Sessions 2-3.',
);
process.exit(1);
