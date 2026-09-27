// Shared steps of the editor features: parse and analyse a text, find the
// scope around a position, find the name under the cursor, and print a
// declaration in Alan syntax.
import { Diagnostic, FuncDecl } from "./ast";
import { LIBRARY, signature } from "./library";
import { Pos, Range } from "./lexer";
import { parse } from "./parser";
import { Analysis, Scope, Sym, analyze, scopeAt } from "./scopes";

export interface SourceAnalysis {
  /** Lexer and parser errors. */
  syntax: Diagnostic[];
  program?: FuncDecl;
  analysis?: Analysis;
  /** True when the text has no syntax errors, so the analysis is a good fallback for later edits. */
  clean: boolean;
}

export function analyzeSource(src: string): SourceAnalysis {
  const { program, diagnostics } = parse(src);
  const result: SourceAnalysis = { syntax: diagnostics, clean: diagnostics.length === 0 };
  if (program) {
    result.program = program;
    result.analysis = analyze(program);
  }
  return result;
}

const comparePos = (a: Pos, b: Pos) => a.line - b.line || a.character - b.character;

/**
 * The scope around a position. A clean current text always decides. A text
 * with syntax errors decides when it puts the position inside a function.
 * Otherwise the fallback (the last analysis of a clean text) gives the names
 * of its outermost function, since positions in the old text no longer match.
 * Last comes the current root, which holds the library.
 */
export function scopeAtPosition(src: string, pos: Pos, fallback?: Analysis): Scope | undefined {
  const { analysis: current, clean } = analyzeSource(src);
  if (current) {
    const scope = scopeAt(current.root, pos);
    if (clean || scope.owner) return scope;
  }
  if (fallback) return fallback.root.children[0] ?? fallback.root;
  return current?.root;
}

/** Every declared symbol with a source range, each once. */
function declarations(root: Scope): Sym[] {
  const out = new Set<Sym>();
  const stack = [root];
  while (stack.length) {
    const s = stack.pop()!;
    for (const sym of s.symbols.values()) if (sym.range) out.add(sym);
    stack.push(...s.children);
  }
  return [...out];
}

/**
 * The symbol named at a position, by a use or by its declaration. A position
 * right after a name also counts, when no name starts there.
 */
export function symbolAt(src: string, pos: Pos): Sym | undefined {
  const analysis = analyzeSource(src).analysis;
  if (!analysis) return undefined;
  const named: { range: Range; sym?: Sym }[] = [
    ...analysis.references.map((r) => ({ range: r.range, sym: r.target })),
    ...declarations(analysis.root).map((sym) => ({ range: sym.range!, sym })),
  ];
  const inside = named.find((n) => comparePos(n.range.start, pos) <= 0 && comparePos(pos, n.range.end) < 0);
  const after = named.find((n) => comparePos(n.range.end, pos) === 0);
  return (inside ?? after)?.sym;
}

/** A declaration as Alan text: "x : int[4]", "a : reference int" or a function header. */
export function declarationText(sym: Sym): string {
  if (sym.kind === "function" || sym.kind === "library") {
    return signature({ name: sym.name, params: sym.params ?? [], ret: sym.typeText });
  }
  return `${sym.name} : ${sym.typeText}`;
}

/** The doc line of a library function, or undefined for anything else. */
export function libraryDoc(sym: Sym): string | undefined {
  return sym.kind === "library" ? LIBRARY.find((f) => f.name === sym.name)?.doc : undefined;
}
