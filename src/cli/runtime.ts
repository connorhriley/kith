import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Resolve both the bundled CLI and source-test layout, without machine-specific paths. */
export function installedCliPath(): string {
  for (const relative of ['./index.js', '../../dist/cli/index.js']) {
    const file = fileURLToPath(new URL(relative, import.meta.url));
    if (fs.existsSync(file)) return fs.realpathSync(file);
  }
  throw new Error('Build or install Kith before configuring clients.');
}
