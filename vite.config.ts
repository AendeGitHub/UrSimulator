import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the build also works when loaded from disk (Electron / Steam build later).
  base: './',
  server: { port: 5173 },
  // The Rapier physics engine ships as embedded WASM (~2 MB), so the main chunk is large by design.
  build: { chunkSizeWarningLimit: 4000 },
  test: { include: ['tests/**/*.test.ts'] },
});
