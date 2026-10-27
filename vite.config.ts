import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  // Relative base so the build also works when loaded from disk (Electron / Steam build later).
  base: './',
  server: { port: 5173 },
  // The Rapier physics engine ships as embedded WASM (~2 MB), so the main chunk is large by design.
  build: { chunkSizeWarningLimit: 4000 },
  // Unique per build: appended to model/data URLs so browsers fetch fresh copies after a deploy.
  define: {
    __BUILD_ID__: JSON.stringify(Date.now().toString(36)),
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: { include: ['tests/**/*.test.ts'] },
});
