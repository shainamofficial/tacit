import { defineConfig } from 'vitest/config';

// Local convenience: pick up DATABASE_URL etc. from .env so integration tests
// run against the docker Postgres without exporting variables by hand.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env — rely on the environment (CI sets what it needs)
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['{packages,apps,evals,config,tooling}/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'evals/corpus/**'],
    passWithNoTests: true,
  },
});
