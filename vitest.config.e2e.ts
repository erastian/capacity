import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['test/setup/global-setup.ts'],
    setupFiles: ['reflect-metadata', 'test/setup/env.ts'],
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});