import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts'],
    setupFiles: ['reflect-metadata'],
  },
});