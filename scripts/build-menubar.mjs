import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  if (process.argv.includes('--if-supported')) process.exit(0);
  throw new Error('Building the menu-bar helper requires macOS and Apple command-line tools.');
}
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-menubar-build-'));
try {
  for (const arch of ['arm64', 'x86_64']) execFileSync('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macosx12.0`, '-module-cache-path', path.join(temp, 'cache'),
    path.join(root, 'src/menubar/RadarProcess.swift'), path.join(root, 'src/menubar/main.swift'), '-o', path.join(temp, arch)], { stdio: 'inherit' });
  execFileSync('xcrun', ['lipo', '-create', path.join(temp, 'arm64'), path.join(temp, 'x86_64'), '-output', path.join(temp, 'kith-menubar')], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', path.join(temp, 'kith-menubar')], { stdio: 'inherit' });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  const staged = path.join(root, `bin/.kith-menubar-${process.pid}.tmp`);
  try {
    fs.copyFileSync(path.join(temp, 'kith-menubar'), staged);
    fs.chmodSync(staged, 0o755);
    // Replace the inode: overwriting a mapped signed executable invalidates macOS's cache.
    fs.renameSync(staged, path.join(root, 'bin/kith-menubar'));
  } finally { fs.rmSync(staged, { force: true }); }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
