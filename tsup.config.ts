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
    // The setup command retains this exact runtime outside transient npx caches.
    noExternal: [/.*/],
    banner: { js: "import { createRequire as __kithRequire } from 'node:module'; const require = __kithRequire(import.meta.url);" },
    onSuccess: 'node scripts/runtime-notices.mjs',
  },
]);
