import { defineConfig } from 'tsup';

export default defineConfig({
  // `index` is browser-safe (no Node APIs); `shadow` uses node:fs.
  entry: ['src/index.ts', 'src/shadow.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
});
