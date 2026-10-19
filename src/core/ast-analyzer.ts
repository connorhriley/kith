import { additiveSource, assertUniqueJsonKeys } from './additive-source.js';
import { repositoryFile } from './repository.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type SymbolKind =
  | 'function'
  | 'type'
  | 'interface'
  | 'class'
  | 'schema'
  | 'route'
  | 'const';

export interface ExtractedSymbol {
  symbolName: string;
  kind: SymbolKind;
  signature: string;
  astHash: string;
  paramsFingerprint: string;
  docComment: string;
}

export interface ExtractedImport {
  rawSpecifier: string;
  resolvedPath: string | null;
  importedSymbols: string[];
}

export interface FileAstAnalysis {
  filePath: string;
  fileHash: string;
  exports: ExtractedSymbol[];
  imports: ExtractedImport[];
}

export class AstAnalyzer {
  /**
   * Analyzes a source file's content to extract exported contracts (functions, types,
   * interfaces, schemas, routes) and imported module dependencies.
   */
  public static analyzeSource(
    repoRoot: string,
    filePath: string,
    sourceContent?: string
  ): FileAstAnalysis {
    const relPath = repositoryFile(repoRoot, filePath);
    const absPath = path.join(repoRoot, relPath);
    const content = sourceContent ?? (fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : '');
    const fileHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

    const exports = AstAnalyzer.extractExports(content);
    const imports = AstAnalyzer.extractImports(repoRoot, relPath, content);

    return {
      filePath: relPath,
      fileHash,
      exports,
      imports,
    };
  }

  public static extractExports(content: string): ExtractedSymbol[] {
    const results = new Map<string, ExtractedSymbol>();
    const lines = content.split(/\r?\n/);

    const getPrecedingDoc = (lineIndex: number): string => {
      const comments: string[] = [];
      let i = lineIndex - 1;
      while (i >= 0) {
        const trimmed = lines[i].trim();
        if (
          trimmed.startsWith('//') ||
          trimmed.startsWith('*') ||
          trimmed.startsWith('/*') ||
          trimmed.startsWith('*/') ||
          trimmed.startsWith('#')
        ) {
          comments.unshift(
            trimmed
              .replace(/^(\/\/+|\/\*+|\*+\/|#|\*)\s?/, '')
              .trim()
          );
          i--;
        } else if (trimmed === '') {
          break;
        } else {
          break;
        }
      }
      return comments.filter(Boolean).join(' ').slice(0, 240);
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;

      // 1. Exported TS/JS function: export [async] function name<T>(params): ReturnType
      const fnMatch = trimmed.match(
        /^export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*([^{;]+))?/
      );
      if (fnMatch) {
        const [, name, rawParams, rawReturn] = fnMatch;
        const cleanReturn = (rawReturn ?? 'unknown').trim();
        const sig = `function ${name}(${AstAnalyzer.normalizeWhitespace(rawParams)}): ${cleanReturn}`;
        const kind: SymbolKind = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(name)
          ? 'route'
          : 'function';
        results.set(name, {
          symbolName: name,
          kind,
          signature: sig,
          astHash: AstAnalyzer.hashSignature(sig),
          paramsFingerprint: AstAnalyzer.computeParamsFingerprint(rawParams, cleanReturn),
          docComment: getPrecedingDoc(i),
        });
        continue;
      }

      // 2. Exported arrow function: export const name = [async] (params): ReturnType =>
      const arrowMatch = trimmed.match(
        /^export\s+const\s+([A-Za-z0-9_$]+)\s*(?::\s*[^=]+)?=\s*(?:async\s+)?(?:\(([^)]*)\)|([A-Za-z0-9_$]+))\s*(?::\s*([^=]+?))?\s*=>/
      );
      if (arrowMatch) {
        const [, name, tupleParams, singleParam, rawReturn] = arrowMatch;
        const rawParams = tupleParams ?? singleParam ?? '';
        const cleanReturn = (rawReturn ?? 'unknown').trim();
        const sig = `function ${name}(${AstAnalyzer.normalizeWhitespace(rawParams)}): ${cleanReturn}`;
        results.set(name, {
          symbolName: name,
          kind: 'function',
          signature: sig,
          astHash: AstAnalyzer.hashSignature(sig),
          paramsFingerprint: AstAnalyzer.computeParamsFingerprint(rawParams, cleanReturn),
          docComment: getPrecedingDoc(i),
        });
        continue;
      }

      // 3. Exported interface: export interface Name { ... }
      const ifaceMatch = trimmed.match(
        /^export\s+interface\s+([A-Za-z0-9_$]+)(?:\s*<[^>]*>)?(?:\s+extends\s+[^{]+)?\s*\{/
      );
      if (ifaceMatch) {
        const name = ifaceMatch[1];
        const bodyFields = AstAnalyzer.extractBracedBlockSummary(lines, i);
        const sig = `interface ${name} { ${bodyFields} }`;
        results.set(name, {
          symbolName: name,
          kind: 'interface',
          signature: sig,
          astHash: AstAnalyzer.hashSignature(sig),
          paramsFingerprint: `interface:${AstAnalyzer.extractFieldTypesFingerprint(bodyFields)}`,
          docComment: getPrecedingDoc(i),
        });
        continue;
      }

      // 4. Exported type alias: export type Name = ...
      const typeMatch = trimmed.match(/^export\s+type\s+([A-Za-z0-9_$]+)(?:\s*<[^>]*>)?\s*=\s*(.+)$/);
      if (typeMatch) {
        const [, name, rhs] = typeMatch;
        const fullRhs = rhs.includes('{') && !rhs.includes('}')
          ? `{ ${AstAnalyzer.extractBracedBlockSummary(lines, i)} }`
          : rhs.replace(/;$/, '').trim();
        const sig = `type ${name} = ${AstAnalyzer.normalizeWhitespace(fullRhs)}`;
        results.set(name, {
          symbolName: name,
          kind: 'type',
          signature: sig,
          astHash: AstAnalyzer.hashSignature(sig),
          paramsFingerprint: `type:${AstAnalyzer.normalizeWhitespace(fullRhs)}`,
          docComment: getPrecedingDoc(i),
        });
        continue;
      }

      // 5. Exported class: export class Name
      const classMatch = trimmed.match(
        /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/
      );
      if (classMatch) {
        const name = classMatch[1];
        const sig = `class ${name}`;
        results.set(name, {
          symbolName: name,
          kind: 'class',
          signature: sig,
          astHash: AstAnalyzer.hashSignature(sig),
          paramsFingerprint: `class:${name}`,
          docComment: getPrecedingDoc(i),
        });
        continue;
      }

      // 6. Exported Zod/Valibot/Drizzle schema or constant: export const NameSchema = ...
      const constMatch = trimmed.match(
        /^export\s+const\s+([A-Za-z0-9_$]+)\s*(?::\s*([^=]+))?\s*=\s*(.+)$/
      );
      if (constMatch) {
        const [, name, explicitType, rhs] = constMatch;
        const isSchema = /Schema$|z\.|pgTable|sqliteTable|mysqlTable/.test(name + rhs);
        const kind: SymbolKind = isSchema ? 'schema' : 'const';
        const sig = `const ${name}: ${(explicitType ?? rhs.slice(0, 60)).replace(/;$/, '').trim()}`;
        results.set(name, {
          symbolName: name,
          kind,
          signature: sig,
          astHash: AstAnalyzer.hashSignature(sig),
          paramsFingerprint: `${kind}:${name}`,
          docComment: getPrecedingDoc(i),
        });
        continue;
      }

      // 7. Python top-level function: def name(params) -> ReturnType:
      const pyFnMatch = line.match(
        /^(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?:/
      );
      if (pyFnMatch && !pyFnMatch[1].startsWith('_')) {
        const [, name, rawParams, rawRet] = pyFnMatch;
        const ret = (rawRet ?? 'Any').trim();
        const sig = `def ${name}(${AstAnalyzer.normalizeWhitespace(rawParams)}) -> ${ret}`;
        results.set(name, {
          symbolName: name,
          kind: 'function',
          signature: sig,
          astHash: AstAnalyzer.hashSignature(sig),
          paramsFingerprint: AstAnalyzer.computeParamsFingerprint(rawParams, ret),
          docComment: getPrecedingDoc(i),
        });
      }
    }

    return Array.from(results.values());
  }

  public static extractImports(
    repoRoot: string,
    sourceRelPath: string,
    content: string
  ): ExtractedImport[] {
    const imports: ExtractedImport[] = [];
    const importRegex =
      /(?:import\s+(?:type\s+)?(?:(\{[^}]*\})|([A-Za-z0-9_$*]+))?\s*(?:,\s*(\{[^}]*\}))?\s*from\s+['"]([^'"]+)['"]|export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\))/g;

    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(content)) !== null) {
      const namedBlock = match[1] ?? match[3] ?? '';
      const defaultIdent = match[2] ?? '';
      const specifier = match[4] ?? match[5] ?? match[6] ?? '';
      if (!specifier) continue;

      const symbols: string[] = [];
      if (defaultIdent) symbols.push(defaultIdent.trim());
      if (namedBlock) {
        const inner = namedBlock.replace(/[{}]/g, '');
        for (const part of inner.split(',')) {
          const clean = part.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '').trim();
          if (clean) symbols.push(clean);
        }
      }

      const resolvedPath = AstAnalyzer.resolveRelativeImport(
        repoRoot,
        sourceRelPath,
        specifier
      );

      imports.push({
        rawSpecifier: specifier,
        resolvedPath,
        importedSymbols: symbols,
      });
    }

    return imports;
  }

  public static resolveRelativeImport(
    repoRoot: string,
    sourceRelPath: string,
    specifier: string
  ): string | null {
    if (!specifier.startsWith('.')) {
      return null;
    }

    const sourceDir = path.dirname(path.join(repoRoot, sourceRelPath));
    // Strip .js / .jsx extension often used in TypeScript ESM imports
    const baseTarget = path.resolve(sourceDir, specifier.replace(/\.(js|jsx|mjs|cjs)$/, ''));

    const candidates = [
      path.resolve(sourceDir, specifier),
      `${baseTarget}.ts`,
      `${baseTarget}.tsx`,
      `${baseTarget}.js`,
      `${baseTarget}.mjs`,
      path.join(baseTarget, 'index.ts'),
      path.join(baseTarget, 'index.tsx'),
      path.join(baseTarget, 'index.js'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        try { return repositoryFile(repoRoot, candidate); } catch { return null; }
      }
    }

    // Even if target file hasn't been flushed to disk yet, infer `.ts` relative path
    const inferred = `${baseTarget}.ts`;
    try { return repositoryFile(repoRoot, inferred); } catch { return null; }
  }

  /**
   * Checks whether a 3-way merge conflict between two modified versions (`contentA` and `contentB`)
   * over `baseContent` is strictly additive (e.g. both agents appended disjoint exports or JSON keys)
   * and therefore auto-mergeable without human intervention.
   */
  public static checkAdditiveMergeability(
    filePath: string,
    baseContent: string,
    contentA: string,
    contentB: string
  ): { autoMergeable: boolean; mergedContent?: string; reason: string } {
    if ([baseContent, contentA, contentB].some(text => Buffer.byteLength(text) > 1_048_576 || text.includes('\0'))) {
      return { autoMergeable: false, reason: 'Binary or oversized conflict requires explicit resolution' };
    }
    // Case 1: JSON files (e.g. package.json, tsconfig.json)
    if (filePath.endsWith('.json')) {
      try {
        const baseObj = AstAnalyzer.parseMergeJson(baseContent || '{}') as Record<string, unknown>;
        const objA = AstAnalyzer.parseMergeJson(contentA) as Record<string, unknown>;
        const objB = AstAnalyzer.parseMergeJson(contentB) as Record<string, unknown>;
        const merged = AstAnalyzer.tryAdditiveJsonMerge(baseObj, objA, objB);
        if (merged !== null) {
          return {
            autoMergeable: true,
            mergedContent: JSON.stringify(merged, null, 2) + '\n',
            reason: 'Disjoint JSON keys added by both agents',
          };
        }
      } catch {
        // Not auto-mergeable JSON
      }
    }

    if (filePath.endsWith('.json')) return { autoMergeable: false, reason: 'JSON changes are not strictly additive objects' };
    return additiveSource(filePath, baseContent, contentA, contentB);
  }

  private static parseMergeJson(text: string): unknown {
    // JSON.parse deliberately accepts duplicate keys and rounds large integers.
    // Neither transformation is appropriate during conflict resolution.
    const value: unknown = JSON.parse(text, (_key, child: unknown) => {
      if (typeof child === 'number' && (Object.is(child, -0) || !Number.isFinite(child) || Number.isInteger(child) && !Number.isSafeInteger(child))) {
        throw new Error('JSON number would lose precision');
      }
      return child;
    });
    assertUniqueJsonKeys(text);
    return value;
  }

  private static tryAdditiveJsonMerge(
    base: Record<string, unknown>,
    a: Record<string, unknown>,
    b: Record<string, unknown>
  ): Record<string, unknown> | null {
    const isObject = (value: unknown): value is Record<string, unknown> =>
      value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!isObject(base) || !isObject(a) || !isObject(b)) return null;
    const result: Record<string, unknown> = {};
    const has = (obj: Record<string, unknown>, key: string) => Object.hasOwn(obj, key);
    const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
    for (const key of new Set([...Object.keys(base), ...Object.keys(a), ...Object.keys(b)])) {
      const original = base[key];
      const left = a[key];
      const right = b[key];
      if (has(base, key)) {
        if (!has(a, key) || !has(b, key)) return null;
        if (isObject(original) && isObject(left) && isObject(right)) {
          const nested = AstAnalyzer.tryAdditiveJsonMerge(original, left, right);
          if (!nested) return null;
          Object.defineProperty(result, key, { value: nested, enumerable: true });
        } else {
          if (!equal(original, left) || !equal(original, right)) return null;
          Object.defineProperty(result, key, { value: original, enumerable: true });
        }
      } else if (has(a, key) && has(b, key)) {
        let value = left;
        if (!equal(left, right)) {
          if (!isObject(left) || !isObject(right)) return null;
          const nested = AstAnalyzer.tryAdditiveJsonMerge({}, left, right);
          if (!nested) return null;
          value = nested;
        }
        Object.defineProperty(result, key, { value, enumerable: true });
      } else {
        Object.defineProperty(result, key, { value: has(a, key) ? left : right, enumerable: true });
      }
    }
    return result;
  }

  private static extractBracedBlockSummary(lines: string[], startIndex: number): string {
    const fields: string[] = [];
    let depth = 0;
    for (let i = startIndex; i < Math.min(lines.length, startIndex + 35); i++) {
      const line = lines[i];
      for (const ch of line) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      if (i > startIndex && depth >= 1) {
        const clean = line.trim().replace(/;$/, '').replace(/,$/, '');
        if (clean && !clean.startsWith('//') && clean !== '}') {
          fields.push(clean);
        }
      }
      if (depth <= 0 && i >= startIndex && line.includes('}')) {
        break;
      }
    }
    return fields.join('; ');
  }

  private static extractFieldTypesFingerprint(bodyFields: string): string {
    return bodyFields
      .split(';')
      .map((f) => {
        const parts = f.split(':');
        return parts.length > 1 ? parts[1].trim().toLowerCase() : f.trim().toLowerCase();
      })
      .filter(Boolean)
      .sort()
      .join(',');
  }

  public static computeParamsFingerprint(rawParams: string, rawReturn: string): string {
    const paramTypes = rawParams
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const colonIdx = p.indexOf(':');
        if (colonIdx === -1) return 'any';
        return p
          .slice(colonIdx + 1)
          .replace(/=.*$/, '')
          .trim()
          .toLowerCase();
      });

    const retNorm = rawReturn
      .replace(/^Promise<(.+)>$/, '$1')
      .trim()
      .toLowerCase();

    return `(${paramTypes.join(',')})->${retNorm}`;
  }

  private static normalizeWhitespace(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
  }

  private static hashSignature(sig: string): string {
    return crypto.createHash('sha256').update(sig).digest('hex').slice(0, 16);
  }
}
