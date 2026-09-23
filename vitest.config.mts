import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const raiz = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(raiz, 'src') },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Cada archivo crea su propia base PGlite en memoria: crearla lleva unos segundos.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
