import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Resolve a workspace package to its source, so tests never need a build first. */
const src = (pkg: string): string =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@interlock/core': src('core'),
      '@interlock/store': src('store'),
      '@interlock/gate': src('gate'),
      '@interlock/chaos': src('chaos'),
      '@interlock/bench': src('bench'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts'],
    passWithNoTests: false,
  },
});
