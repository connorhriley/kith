/**
 * Scope grammar: slash-separated literals, * and ? within a segment, and ** as
 * a whole segment. Wildcards include dotfiles. No braces, classes, negation,
 * extglobs or escaping. Reject unsupported syntax instead of guessing.
 */
export function scopeSegments(pattern: string, literal = false): string[] {
  if (!pattern || pattern.length > 512 || (literal ? /[\x00-\x1f\x7f\\]/u : /[\x00-\x1f\x7f\\[\]{}()!]/u).test(pattern)) {
    throw new Error(`Unsupported scope syntax: ${pattern}`);
  }
  const segments = pattern.split('/');
  if (segments.length > 64 || segments.some(s => !s || s === '.' || s === '..' || !literal && s.includes('**') && s !== '**')) {
    throw new Error(`Invalid scope segments: ${pattern}`);
  }
  return segments;
}

// Intersection of two segment wildcard automata. Track empty/dot/dot-dot so
// only actual filename components can witness an overlap.
function segmentsOverlap(a: string, b: string, literalA: boolean, literalB: boolean): boolean {
  const STAR = Symbol('star'), ANY = Symbol('any');
  const tokens = (text: string, literal: boolean) => Array.from(text).map(c => !literal && c === '*' ? STAR : !literal && c === '?' ? ANY : c);
  const left = tokens(a, literalA), right = tokens(b, literalB);
  const queue: Array<[number, number, number]> = [[0, 0, 0]];
  const seen = new Set<string>();
  for (let q = 0; q < queue.length; q++) {
    const [i, j, kind] = queue[q];
    const key = `${i},${j},${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (i === left.length && j === right.length && kind === 3) return true;
    const x = left[i], y = right[j];
    if (x === STAR) queue.push([i + 1, j, kind]);
    if (y === STAR) queue.push([i, j + 1, kind]);
    if (x === undefined || y === undefined) continue;
    const anyX = x === STAR || x === ANY, anyY = y === STAR || y === ANY;
    if (!anyX && !anyY && x !== y) continue;
    const literal = !anyX ? x : !anyY ? y : undefined;
    const nextI = x === STAR ? i : i + 1, nextJ = y === STAR ? j : j + 1;
    if (literal === undefined || literal === '.') {
      queue.push([nextI, nextJ, kind === 0 ? 1 : kind === 1 ? 2 : 3]);
    }
    if (literal === undefined || literal !== '.') queue.push([nextI, nextJ, 3]);
  }
  return false;
}

/** Exact language intersection, including zero-directory and repeated globstars. */
export function scopesOverlap(a: string, b: string, literalA = false, literalB = false): boolean {
  const left = scopeSegments(a, literalA), right = scopeSegments(b, literalB);
  const queue: Array<[number, number, boolean]> = [[0, 0, false]];
  const seen = new Set<string>();
  const memo = new Map<string, boolean>();
  for (let q = 0; q < queue.length; q++) {
    const [i, j, consumed] = queue[q];
    const key = `${i},${j},${consumed}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (i === left.length && j === right.length && consumed) return true;
    const x = left[i], y = right[j];
    const starA = !literalA && x === '**', starB = !literalB && y === '**';
    if (starA) queue.push([i + 1, j, consumed]);
    if (starB) queue.push([i, j + 1, consumed]);
    if (x === undefined || y === undefined) continue;
    const pair = JSON.stringify([x, y]);
    let overlap = memo.get(pair);
    if (overlap === undefined) {
      overlap = segmentsOverlap(starA ? '*' : x, starB ? '*' : y, starA ? false : literalA, starB ? false : literalB);
      memo.set(pair, overlap);
    }
    if (overlap) queue.push([starA ? i : i + 1, starB ? j : j + 1, true]);
  }
  return false;
}
