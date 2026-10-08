import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Some maker-ladder tests run the real (shortened) timers.
    testTimeout: 30_000,
  },
});
