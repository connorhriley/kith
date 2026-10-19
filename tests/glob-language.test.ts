import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { LockEngine } from '../src/index.js';
import { scopeSegments } from '../src/core/glob.js';

it.each([
  ['src/**/*.ts', 'src/a.ts', true], ['src/**/*.ts', 'src/a/b.ts', true],
  ['src/**/foo.ts', 'src/**/bar.ts', false], ['a/**/b/**/c', 'a/b/c', true],
  ['a/**/b', 'a/**/b/**/c', false], ['a/**/b', 'a/**/b/**/c/**/b', true], ['a/*/c', 'a/c', false],
  ['foo*bar', 'foo*baz', false], ['*ab*', '*ba*', true],
  ['a?b', 'ac?', true], ['*a', '*b', false],
  ['**/*.env', '.env', true], ['**', '.hidden/.env', true],
  ['.??', '??.', true], ['.?', '?.', false],
  ['**/end', 'start/**', true], ['src/*.ts', 'src/*.tsx', false],
  ['symbol:a.ts#x', 'symbol:a.ts#y', false], ['symbol:a.ts#x', '**/*.ts', true],
])('intersects %s with %s = %s', (a, b, expected) => {
  expect(LockEngine.patternsOverlap(a, b)).toBe(expected);
  expect(LockEngine.patternsOverlap(b, a)).toBe(expected);
});

it('rejects unsupported syntax and treats already-persisted unsupported locks conservatively', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-globs-'));
  try {
    for (const pattern of ['src/{a,b}.ts', '[a-z].ts', '!secret', 'a/**x', 'a/**/../b', 'a/(x)', 'a\\b', 'a/'.repeat(65), 'x'.repeat(513)]) {
      expect(() => LockEngine.normalizePattern(root, pattern)).toThrow();
      expect(LockEngine.patternsOverlap(pattern, 'unrelated/file')).toBe(true);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Independent matcher using recursive path/segment expansion, rather than
// the product-automaton implementation under test.
function matches(pattern: string, file: string): boolean {
  const p = pattern.split('/'), f = file.split('/');
  function visit(i: number, j: number): boolean {
    if (i === p.length) return j === f.length;
    if (p[i] === '**') return visit(i + 1, j) || j < f.length && visit(i, j + 1);
    const regex = new RegExp('^' + p[i].split('').map(c => c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$', 'u');
    return j < f.length && regex.test(f[j]) && visit(i + 1, j + 1);
  }
  return visit(0, 0);
}

it('never misses an overlap witnessed by a concrete path across a generated pattern corpus', () => {
  const segments = ['a', 'b', '.a', 'ab', 'ba'];
  const files = [...segments, ...segments.flatMap(a => segments.map(b => `${a}/${b}`)), ...segments.flatMap(a => segments.flatMap(b => segments.map(c => `${a}/${b}/${c}`)))];
  const parts = ['a', 'b', '*', '?', 'a*', '*b', '.?', '**'];
  const patterns = [...parts, ...parts.flatMap(a => parts.map(b => `${a}/${b}`))];
  const witnesses = patterns.map(p => new Set(files.filter(f => matches(p, f))));
  for (let a = 0; a < patterns.length; a++) for (let b = a; b < patterns.length; b++) {
    const overlap = LockEngine.patternsOverlap(patterns[a], patterns[b]);
    expect(LockEngine.patternsOverlap(patterns[b], patterns[a])).toBe(overlap);
    if ([...witnesses[a]].some(f => witnesses[b].has(f))) expect(overlap, `${patterns[a]} versus ${patterns[b]}`).toBe(true);
  }
  // No globstar: finite bounded path generation is complete for this corpus.
  const simple = ['a', 'b', '?', 'a?', '?b', 'ab', 'ba', '.?'];
  const names = ['a', 'b', '.'].flatMap(a => ['a', 'b', '.'].map(b => a + b)).filter(f => f !== '..');
  for (const a of simple) for (const b of simple) {
    const found = [...names, 'a', 'b'].some(f => matches(a, f) && matches(b, f));
    expect(LockEngine.patternsOverlap(a, b), `${a} versus ${b}`).toBe(found);
  }
  expect(() => scopeSegments('**/**')).not.toThrow();
});
