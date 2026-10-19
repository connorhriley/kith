import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'command-worker': 'src/core/command-worker.ts',
      'cli/index': 'src/cli/index.ts',
    },
    format: ['esm'],
    target: 'node22',
    dts: true,
    clean: true,
    sourcemap: true,
    splitting: false,
  },
]);
