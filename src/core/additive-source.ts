import { createRequire } from 'node:module';
import type * as TypeScript from 'typescript';
const require = createRequire(import.meta.url);

type Result = { autoMergeable: boolean; mergedContent?: string; reason: string };

/** Parse only when resolving a conflict; normal coordinator processes need no compiler heap. */
export function additiveSource(file: string, base: string, a: string, b: string): Result {
  const refuse = (reason: string): Result => ({ autoMergeable: false, reason });
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/u.test(file)) return refuse('Unsupported source language for automatic resolution');
  if (!a.startsWith(base) || !b.startsWith(base) || base && !base.endsWith('\n')) {
    return refuse('Source edits must append complete declarations after an unchanged newline-terminated base');
  }
  const ts: typeof TypeScript = require('typescript');
  const kind = file.endsWith('tsx') ? ts.ScriptKind.TSX : file.endsWith('jsx') ? ts.ScriptKind.JSX
    : /\.[cm]?js$/u.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const parse = (text: string) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const original = parse(base), left = parse(a), right = parse(b);
  const invalid = (source: TypeScript.SourceFile) =>
    (source as TypeScript.SourceFile & { parseDiagnostics: readonly TypeScript.Diagnostic[] }).parseDiagnostics.length > 0;
  if ([original, left, right].some(invalid)) return refuse('Source has parse errors');

  function additions(source: TypeScript.SourceFile): { names: string[]; nodes: TypeScript.Statement[] } | null {
    const nodes = source.statements.filter(node => node.getStart(source) >= base.length);
    if (!nodes.length || source.statements.length !== original.statements.length + nodes.length) return null;
    const names: string[] = [];
    for (const node of nodes) {
      if (!(ts.isFunctionDeclaration(node) && node.body || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node))) return null;
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
      if (!modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
        || modifiers.some(m => ![ts.SyntaxKind.ExportKeyword, ts.SyntaxKind.AsyncKeyword].includes(m.kind))
        || ts.canHaveDecorators(node) && ts.getDecorators(node)?.length || !node.name) return null;
      if (kind === ts.ScriptKind.JS || kind === ts.ScriptKind.JSX) {
        const hasTypes = (child: TypeScript.Node): boolean => ts.isTypeNode(child)
          || ts.isInterfaceDeclaration(child) || ts.isTypeAliasDeclaration(child)
          || ts.forEachChild(child, descendant => hasTypes(descendant) || undefined) === true;
        if (hasTypes(node)) return null;
      }
      names.push(node.name.text);
    }
    return { names, nodes };
  }
  const addedA = additions(left), addedB = additions(right);
  if (!addedA || !addedB) return refuse('Only appended named exported functions, interfaces and type aliases can be resolved; imports, initializers and top-level execution remain conflicts');
  const allNames = [...addedA.names, ...addedB.names];
  if (new Set(allNames).size !== allNames.length) return refuse('Added declarations have overlapping names');
  // Conservative identifier checks catch hoisting/shadowing and cross-branch
  // dependencies without pretending parse success proves semantic compatibility.
  const contains = (node: TypeScript.Node, names: Set<string>): boolean => {
    if (ts.isIdentifier(node) && names.has(node.text)) return true;
    return ts.forEachChild(node, child => contains(child, names) || undefined) === true;
  };
  if (contains(original, new Set(allNames))
    || addedA.nodes.some(node => contains(node, new Set(addedB.names)))
    || addedB.nodes.some(node => contains(node, new Set(addedA.names)))) {
    return refuse('Added names overlap existing identifiers or create cross-branch dependencies');
  }
  const mergedContent = a + '\n' + b.slice(base.length);
  const merged = parse(mergedContent);
  if (invalid(merged) || merged.statements.length !== original.statements.length + addedA.nodes.length + addedB.nodes.length) {
    return refuse('Combined source does not preserve complete declarations');
  }
  return { autoMergeable: true, mergedContent, reason: `Disjoint appended declarations (${addedA.names.join(', ')} + ${addedB.names.join(', ')})` };
}

export function assertUniqueJsonKeys(text: string): void {
  const ts: typeof TypeScript = require('typescript');
  const source = ts.parseJsonText('merge.json', text);
  const decimalKey = (raw: string): string => {
    const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
    if (!match || (match[3]?.length ?? 0) > 8) throw new Error('Unsupported JSON number');
    let digits = (match[1] + (match[2] ?? '')).replace(/^0+/, '');
    if (!digits) return '0';
    const trailing = /0*$/.exec(digits)![0].length;
    digits = digits.slice(0, digits.length - trailing);
    return digits + 'e' + (BigInt(match[3] ?? '0') - BigInt(match[2]?.length ?? 0) + BigInt(trailing));
  };
  function visit(node: TypeScript.Node): void {
    if (ts.isNumericLiteral(node) && decimalKey(node.getText(source)) !== decimalKey(String(Number(node.getText(source))))) {
      throw new Error('JSON number would change during serialization');
    }
    if (ts.isObjectLiteralExpression(node)) {
      const names = new Set<string>();
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) throw new Error('Unsupported JSON property');
        const name = property.name.text;
        if (names.has(name)) throw new Error('Duplicate JSON key');
        names.add(name);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
