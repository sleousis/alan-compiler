// Live diagnostics: lexer and parser errors plus the name checks of scopes.ts.
import { Diagnostic } from "./ast";
import { SourceAnalysis, analyzeSource } from "./analysis";

/**
 * Diagnostics for a text, or for a text already analysed. While the file has
 * syntax errors the partial tree makes most name errors unreliable (a broken
 * declaration looks like an unknown name), so only duplicate declarations
 * are shown then.
 */
export function computeDiagnostics(source: string | SourceAnalysis): Diagnostic[] {
  const { syntax, analysis, clean } = typeof source === "string" ? analyzeSource(source) : source;
  const names = analysis?.diagnostics ?? [];
  const shown = clean ? names : names.filter((d) => d.code === "duplicate");
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
