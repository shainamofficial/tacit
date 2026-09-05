// `pnpm compile --org=<slug> --budget=<usd>` — local pipeline run with a $ cap (F-CMP-2).
// The pipeline lands in Week 3; until then this fails loudly rather than pretending.
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key ?? arg, value ?? 'true'];
  }),
);

console.error(
  `compile pipeline not implemented yet (docs/implementation-plan.md §5, Week 3). ` +
    `org=${args['org'] ?? '?'} budget=${args['budget'] ?? '?'}`,
);
process.exit(1);
