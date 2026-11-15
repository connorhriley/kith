import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Paths Git ignores (build output, dev-server logs, traces) are not shared source. Kith neither
 * locks them nor reports merge conflicts on them. A tracked file is never "ignored" here, matching
 * `git check-ignore` without `--no-index`.
 */

/** Nearest directory at or above `dir` (not above `stop`) that is its own Git checkout, else `stop`. */
function owningRepository(stop: string, relative: string): { cwd: string; rel: string } {
  const parts = relative.split('/');
  for (let depth = parts.length - 1; depth > 0; depth--) {
    const candidate = path.join(stop, ...parts.slice(0, depth));
    if (fs.existsSync(path.join(candidate, '.git'))) {
      return { cwd: candidate, rel: parts.slice(depth).join('/') };
    }
  }
  return { cwd: stop, rel: relative };
}

function checkIgnore(cwd: string, rels: string[]): Set<string> {
  const ignored = new Set<string>();
  for (let i = 0; i < rels.length; i += 500) {
    const chunk = rels.slice(i, i + 500);
    if (!chunk.length) continue;
    try {
      const out = execFileSync('git', ['check-ignore', '-z', '--stdin'], {
        cwd,
        input: chunk.join('\0') + '\0',
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        maxBuffer: 4 * 1024 * 1024,
        timeout: 10_000,
      });
      for (const p of out.split('\0')) if (p) ignored.add(p);
    } catch (error) {
      // Exit 1 means "nothing ignored"; any other failure (not a repository, git missing) fails open.
      const stdout = (error as { stdout?: unknown }).stdout;
      if (typeof stdout === 'string') for (const p of stdout.split('\0')) if (p) ignored.add(p);
    }
  }
  return ignored;
}

/**
 * Returns repository-relative directory prefixes that contain at least one Git-tracked file,
 * so walkers can safely prune ignored subtrees without dropping force-tracked files inside them.
 */
export function trackedDirectoryPrefixes(root: string): Set<string> {
  const prefixes = new Set<string>();
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
      timeout: 10_000,
    });
    for (const entry of out.split('\0')) {
      if (!entry) continue;
      const parts = entry.replace(/\\/g, '/').split('/');
      for (let i = 1; i < parts.length; i++) prefixes.add(parts.slice(0, i).join('/'));
    }
  } catch { /* Not a Git checkout or git unavailable; fail open. */ }
  return prefixes;
}

/**
 * Returns the subset of repository-relative `files` that Git ignores, asking the repository each
 * path belongs to (a nested checkout applies its own ignore rules, not its parent's).
 */
export function ignoredPaths(root: string, files: string[]): Set<string> {
  const result = new Set<string>();
  const groups = new Map<string, Array<{ rel: string; original: string }>>();
  for (const original of new Set(files)) {
    const norm = original.replace(/\\/g, '/');
    if (!norm || norm.startsWith('../') || path.isAbsolute(norm) || /[*?[\]]/.test(norm)) continue;
    const { cwd, rel } = owningRepository(root, norm);
    const group = groups.get(cwd) ?? [];
    group.push({ rel, original });
    groups.set(cwd, group);
  }
  for (const [cwd, entries] of groups) {
    const ignored = checkIgnore(cwd, entries.map(e => e.rel));
    for (const e of entries) if (ignored.has(e.rel)) result.add(e.original);
  }
  return result;
}

export function isIgnoredPath(root: string, file: string): boolean {
  return ignoredPaths(root, [file]).has(file);
}

/**
 * Walk `startDir` skipping `skipDirNames`, git-ignored subtrees with no tracked files, and
 * git-ignored files. Supports nested Git checkouts via `ignoredPaths` or stopping at them.
 */
export function walkNonIgnoredFiles(params: {
  rootDir: string;
  startDir?: string;
  skipDirNames: Set<string>;
  skipDotEntries?: boolean;
  stopAtNestedGit?: boolean;
  acceptFile?: (name: string) => boolean;
}): string[] {
  const { rootDir, startDir = rootDir, skipDirNames, skipDotEntries = false, stopAtNestedGit = false, acceptFile } = params;
  const trackedDirs = trackedDirectoryPrefixes(rootDir);
  const acc: string[] = [];

  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    if (stopAtNestedGit && dir !== rootDir && fs.existsSync(path.join(dir, '.git'))) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const subdirs: Array<{ rel: string; full: string }> = [];
    const files: Array<{ rel: string; full: string }> = [];
    for (const entry of entries) {
      if ((skipDotEntries && entry.name.startsWith('.')) || skipDirNames.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootDir, full).replace(/\\/g, '/');
      if (entry.isDirectory()) subdirs.push({ rel, full });
      else if (entry.isFile() && (!acceptFile || acceptFile(entry.name))) files.push({ rel, full });
    }
    const ignoredDirs = subdirs.length ? ignoredPaths(rootDir, subdirs.map((d) => d.rel)) : new Set<string>();
    const ignoredFiles = files.length ? ignoredPaths(rootDir, files.map((f) => f.rel)) : new Set<string>();
    for (const f of files) if (!ignoredFiles.has(f.rel)) acc.push(f.full);
    for (const d of subdirs) if (!ignoredDirs.has(d.rel) || trackedDirs.has(d.rel)) walk(d.full);
  };

  walk(startDir);
  return acc;
}
