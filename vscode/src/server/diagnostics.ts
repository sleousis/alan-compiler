// Live diagnostics: lexer and parser errors plus the name checks of scopes.ts.
import { Diagnostic } from "./ast";
import { analyzeSource } from "./analysis";

/**
 * While the file has syntax errors, the partial tree makes most name errors
 * unreliable (a broken declaration looks like an unknown name). Only
 * duplicate declarations are shown then.
 */
const TRUSTED_WHILE_BROKEN = /is already declared/;

export function computeDiagnostics(src: string): Diagnostic[] {
  const { syntax, analysis, clean } = analyzeSource(src);
  const names = analysis?.diagnostics ?? [];
  const shown = clean ? names : names.filter((d) => TRUSTED_WHILE_BROKEN.test(d.message));
  return [...syntax, ...shown].sort(
    (a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character,
  );
}

/**
 * Adds the compiler's diagnostics to the live ones, dropping each compiler
 * diagnostic on a line that already has a live one.
 */
export function mergeDiagnostics<T extends { range: { start: { line: number } } }>(live: T[], compiler: T[]): T[] {
  const lines = new Set(live.map((d) => d.range.start.line));
  return [...live, ...compiler.filter((d) => !lines.has(d.range.start.line))];
}
