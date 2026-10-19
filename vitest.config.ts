import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Lifecycle files create their own concurrent processes. Keep the 50-worker
    // stress workload from multiplying unrelated lease/signal timing workloads.
    fileParallelism: false,
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
