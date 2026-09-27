// Find references, document highlights and rename. A use belongs to a
// declaration when the analysis resolves it to the same symbol object.
//
// A rename is checked by doing it: the new text is analysed again, and the
// rename is refused when that adds a name error or makes any use resolve to
// a different declaration. This follows every scoping rule of scopes.ts,
// which follows the compiler, without repeating them here.
import { analyzeSource, declarations, nameAt } from "./analysis";
import { Pos, Range, lex } from "./lexer";
import { Analysis, Sym } from "./scopes";

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

type Edit = { range: Range; newText: string };

const comparePos = (a: Pos, b: Pos) => a.line - b.line || a.character - b.character;
const key = (p: Pos) => `${p.line}:${p.character}`;

/** The analysis of a text without syntax errors, or the error to show. */
function cleanAnalysis(src: string): Analysis | { error: string } {
  const { analysis, clean } = analyzeSource(src);
  if (!analysis || !clean) return { error: "Fix the syntax errors before renaming." };
  return analysis;
}

/** The symbol named at a position and the range of the name there. Unknown names have none. */
export function symbolAt(src: string, pos: Pos): { sym: Sym; range: Range } | undefined {
  const analysis = analyzeSource(src).analysis;
  const found = analysis && nameAt(analysis, pos);
  return found?.sym ? { sym: found.sym, range: found.range } : undefined;
}

function referencesOf(analysis: Analysis, sym: Sym, includeDeclaration: boolean): Range[] {
  const out = analysis.references.filter((r) => r.target === sym).map((r) => r.range);
  if (includeDeclaration && sym.range) out.push(sym.range);
  return out.sort((a, b) => comparePos(a.start, b.start));
}

/** Every use of the name at a position, in source order, and its declaration on request. */
export function references(src: string, pos: Pos, includeDeclaration: boolean): Range[] {
  const analysis = analyzeSource(src).analysis;
  const sym = analysis && nameAt(analysis, pos)?.sym;
  return sym ? referencesOf(analysis, sym, includeDeclaration) : [];
}

/** The renamable symbol at a position in a clean text, or the reason there is none. */
function target(src: string, pos: Pos): { analysis: Analysis; sym: Sym; range: Range } | { error: string } {
  const analysis = cleanAnalysis(src);
  if ("error" in analysis) return analysis;
  const found = nameAt(analysis, pos);
  if (!found?.sym) return { error: "There is no name here to rename." };
  if (found.sym.kind === "library") return { error: "Library functions cannot be renamed." };
  return { analysis, sym: found.sym, range: found.range };
}

export function prepareRename(src: string, pos: Pos): { range: Range; placeholder: string } | { error: string } {
  const t = target(src, pos);
  return "error" in t ? t : { range: t.range, placeholder: t.sym.name };
}

export function rename(src: string, pos: Pos, newName: string): { edits: Edit[] } | { error: string } {
  const t = target(src, pos);
  if ("error" in t) return t;
  if (!IDENTIFIER.test(newName)) return { error: `'${newName}' is not a valid name.` };
  if (lex(newName).tokens[0].kind !== "id") return { error: `'${newName}' is a keyword.` };
  if (newName === t.sym.name) return { edits: [] };

  const edits = referencesOf(t.analysis, t.sym, true).map((range) => ({ range, newText: newName }));
  const problem = check(t.analysis, t.sym, applyEdits(src, edits), edits, newName);
  return problem ? { error: problem } : { edits };
}

function applyEdits(src: string, edits: Edit[]): string {
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);
  const offset = (p: Pos) => lineStarts[p.line] + p.character;
  let out = src;
  for (const e of [...edits].sort((a, b) => comparePos(b.range.start, a.range.start))) {
    out = out.slice(0, offset(e.range.start)) + e.newText + out.slice(offset(e.range.end));
  }
  return out;
}

/**
 * Where a position of the old text is in the new one. Every edit replaces a
 * name on one line, so only later positions on the same line move.
 */
function mapper(edits: Edit[]): (p: Pos) => Pos {
  return (p) => {
    let character = p.character;
    for (const e of edits) {
      const r = e.range;
      if (r.start.line === p.line && r.end.character <= p.character) {
        character += e.newText.length - (r.end.character - r.start.character);
      }
    }
    return { line: p.line, character };
  };
}

function clash(newName: string, other: Sym | undefined): string {
  if (!other) return `'${newName}' would clash with another name.`;
  if (!other.range) return `'${newName}' would clash with the library function '${other.name}'.`;
  return `'${newName}' would clash with the declaration at line ${other.range.start.line + 1}.`;
}

/**
 * Compares the analysis of the renamed text with the old one. Returns the
 * reason to refuse, or undefined when the rename is safe.
 */
function check(before: Analysis, sym: Sym, text: string, edits: Edit[], newName: string): string | undefined {
  const after = cleanAnalysis(text);
  if ("error" in after) return clash(newName, undefined);
  const map = mapper(edits);
  // A declaration by where it starts in the new text, or by name for the library.
  const oldDecl = (s?: Sym) => !s ? "none" : s.range ? key(map(s.range.start)) : `library ${s.name}`;
  const newDecl = (s?: Sym) => !s ? "none" : s.range ? key(s.range.start) : `library ${s.name}`;
  const renamed = oldDecl(sym);

  // A use that now finds another declaration either was captured by one
  // named newName, or is the use of a newName that the renamed symbol now hides.
  const now = new Map(after.references.map((r) => [key(r.range.start), r.target]));
  for (const r of before.references) {
    const was = r.target;
    const is = now.get(key(map(r.range.start)));
    if (oldDecl(was) === newDecl(is)) continue;
    return clash(newName, newDecl(is) === renamed ? was : is);
  }
  if (now.size !== before.references.length) return clash(newName, undefined);

  const known = new Set(before.diagnostics.map((d) => `${d.code} ${key(map(d.range.start))}`));
  if (after.diagnostics.every((d) => known.has(`${d.code} ${key(d.range.start)}`))) return undefined;
  // A new error: name the other declaration of newName closest before the renamed one.
  const at = map(sym.range!.start);
  const others = declarations(after.root)
    .filter((s) => s.name === newName && newDecl(s) !== renamed)
    .sort((a, b) => comparePos(a.range!.start, b.range!.start));
  const other = others.filter((s) => comparePos(s.range!.start, at) < 0).pop() ?? others[0]
    ?? [...after.root.symbols.values()].find((s) => s.name === newName);
  return clash(newName, other);
}
