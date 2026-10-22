import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface RepositoryLayout {
  checkoutRoot: string;
  commonGitDir: string | null;
  isLinkedWorktree: boolean;
  coordDir: string;
}

/** Resolve missing leaves through their nearest existing parent; never hide a broken link. */
export function physicalPath(input: string): string {
  if (process.platform === 'win32') input = input.replaceAll('/', path.sep);
  const absolute = path.isAbsolute(input) ? input : process.cwd() + path.sep + input;
  let current = path.parse(absolute).root;
  for (const component of absolute.slice(current.length).split(path.sep)) {
    if (!component || component === '.') continue;
    if (component === '..') { current = path.dirname(current); continue; }
    const candidate = path.join(current, component);
    try {
      fs.lstatSync(candidate);
      current = fs.realpathSync.native(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A symlink with a missing target is not a missing leaf.
      try { fs.lstatSync(candidate); throw new Error(`Unresolved symlink: ${candidate}`); }
      catch (statError) { if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError; }
      current = candidate;
    }
  }
  return current;
}

export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

/** Resolve a concrete file, including missing leaves, and refuse symlinks leaving the checkout. */
export function repositoryFile(root: string, file: string): string {
  if (!file || /[\x00-\x1f\x7f]/u.test(file) || process.platform !== 'win32' && file.includes('\\')) throw new Error(`Invalid file path: ${file}`);
  const canonicalRoot = physicalPath(root);
  const target = physicalPath(path.isAbsolute(file) ? file : canonicalRoot + path.sep + file);
  if (!isWithin(canonicalRoot, target) || target === canonicalRoot) {
    throw new Error(`File is outside repository: ${file}`);
  }
  return path.relative(canonicalRoot, target).split(path.sep).join('/');
}

/** Git's common directory identifies shared coordination; Git operations stay in this checkout. */
export function discoverRepository(input: string): RepositoryLayout {
  const directory = fs.realpathSync.native(input);
  if (directory === path.parse(directory).root) {
    throw new Error('Cannot coordinate a filesystem root; select an explicit project with --repo.');
  }
  if (!fs.statSync(directory).isDirectory()) throw new Error(`Not a directory: ${input}`);
  const git = (...args: string[]) => execFileSync('git', ['rev-parse', ...args], {
    cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/\r?\n$/, '');
  try {
    const checkoutRoot = fs.realpathSync(git('--show-toplevel'));
    if (!isWithin(checkoutRoot, directory)) throw new Error('Git routing environment selects a different checkout');
    const commonGitDir = fs.realpathSync(git('--path-format=absolute', '--git-common-dir'));
    const isLinkedWorktree = fs.realpathSync(git('--absolute-git-dir')) !== commonGitDir;
    // Preserve the existing main-checkout .coord location for ordinary repositories.
    // Separate Git directories use their own shared state, independent of checkout location.
    const coordDir = path.basename(commonGitDir) === '.git'
      ? path.join(path.dirname(commonGitDir), '.coord')
      : path.join(commonGitDir, 'kith');
    return { checkoutRoot, commonGitDir, coordDir, isLinkedWorktree };
  } catch (error) {
    // Never silently create an independent coordinator inside a broken/unavailable Git repo.
    const markerExists = (file: string) => {
      try { fs.lstatSync(file); return true; }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return false; throw failure; }
    };
    for (let current = directory; ; current = path.dirname(current)) {
      if (markerExists(path.join(current, '.git')) || fs.existsSync(path.join(current, 'HEAD')) && fs.existsSync(path.join(current, 'objects'))) {
        throw new Error(`Cannot discover Git repository at ${directory}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (path.dirname(current) === current) break;
    }
    if (process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_COMMON_DIR) throw error;
    return { checkoutRoot: directory, commonGitDir: null, coordDir: path.join(directory, '.coord'), isLinkedWorktree: false };
  }
}

/** Read-only probe using an existing directory; uncertain results retain exclusion. */
export function caseSensitivePaths(root: string): boolean {
  for (let current = physicalPath(root); path.dirname(current) !== current; current = path.dirname(current)) {
    const name = path.basename(current);
    const variant = name.replace(/[a-zA-Z]/, c => c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
    if (variant === name) continue;
    try {
      const original = fs.statSync(current);
      const alias = fs.statSync(path.join(path.dirname(current), variant));
      return original.dev !== alias.dev || original.ino !== alias.ino;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      return false;
    }
  }
  return false;
}
