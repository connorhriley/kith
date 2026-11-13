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
  if (!rels.length) return ignored;
  try {
    const out = execFileSync('git', ['check-ignore', '-z', '--stdin'], {
      cwd, input: rels.join('\0') + '\0', encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 10_000,
    });
    for (const p of out.split('\0')) if (p) ignored.add(p);
  } catch (error) {
    // Exit 1 means "nothing ignored"; any other failure (not a repository, git missing) fails open.
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === 'string') for (const p of stdout.split('\0')) if (p) ignored.add(p);
  }
  return ignored;
}

/**
 * Returns the subset of repository-relative `files` that Git ignores, asking the repository each
 * path belongs to (a nested checkout applies its own ignore rules, not its parent's).
 */
export function ignoredPaths(root: string, files: string[]): Set<string> {
  const result = new Set<string>();
  const groups = new Map<string, Array<{ rel: string; original: string }>>();
  for (const original of new Set(files)) {
    if (!original || original.startsWith('../') || path.isAbsolute(original) || /[*?[\]]/.test(original)) continue;
    const { cwd, rel } = owningRepository(root, original);
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
