import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.platform !== 'darwin') throw new Error('Native menu-bar process tests require macOS.');
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-menubar-test-'));
try {
  execFileSync('xcrun', ['swiftc', '-module-cache-path', path.join(temp, 'cache'), path.join(root, 'src/menubar/RadarProcess.swift'),
    path.join(root, 'tests/menubar/main.swift'), '-o', path.join(temp, 'probe')], { stdio: 'inherit', timeout: 120000 });
  execFileSync(path.join(temp, 'probe'), [], { stdio: 'inherit', timeout: 15000 });
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
