// Live diagnostics: lexer and parser errors plus the checks of scopes.ts.
import { Diagnostic, SemanticCode } from "./ast";
import { SourceAnalysis, analyzeSource } from "./analysis";

/**
 * Errors that stay while the file has syntax errors. They come from a
 * declaration alone, so a part the parser dropped cannot cause them.
 */
const SHOWN_WITH_SYNTAX_ERRORS = new Set<SemanticCode | undefined>(["duplicate", "declaration"]);

/**
 * Diagnostics for a text, or for a text already analysed, in source order.
 * While the file has syntax errors the partial tree makes most other errors
 * unreliable (a broken declaration looks like an unknown name), so only
 * errors of declarations are shown then.
 */
export function computeDiagnostics(source: string | SourceAnalysis): Diagnostic[] {
  const { syntax, analysis, clean } = typeof source === "string" ? analyzeSource(source) : source;
  const semantic = analysis?.diagnostics ?? [];
  const shown = clean ? semantic : semantic.filter((d) => SHOWN_WITH_SYNTAX_ERRORS.has(d.code));
  return [...syntax, ...shown].sort(
    (a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character,
  );
}

/**
 * The error `alanc check` would report first: the first lexer or parser
 * error in the file, or else the first error the checks meet.
 */
export function firstError(source: string | SourceAnalysis): Diagnostic | undefined {
  const { syntax, analysis } = typeof source === "string" ? analyzeSource(source) : source;
  return syntax[0] ?? analysis?.diagnostics[0];
}

/**
 * Adds the compiler's diagnostics to the live ones, dropping each compiler
 * diagnostic on a line that already has a live one.
 */
export function mergeDiagnostics<T extends { range: { start: { line: number } } }>(live: T[], compiler: T[]): T[] {
  const lines = new Set(live.map((d) => d.range.start.line));
  return [...live, ...compiler.filter((d) => !lines.has(d.range.start.line))];
}
