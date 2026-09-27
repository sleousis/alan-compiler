// Completion: keywords, the names visible at the cursor and the library.
import { declarationText, libraryDoc, scopeAtPosition } from "./analysis";
import { LIBRARY, signature } from "./library";
import { Pos } from "./lexer";
import { Analysis, visible } from "./scopes";

export interface CompletionEntry {
  label: string;
  kind: "keyword" | "function" | "variable" | "parameter" | "library" | "snippet";
  detail?: string;
  documentation?: string;
  insertText?: string;
}

const KEYWORDS = ["if", "else", "while", "return", "int", "byte", "reference", "proc", "true", "false"];

/**
 * Completion items at a position. `fallback` is the last analysis of a clean
 * text, used when the current text puts the position in no function.
 */
export function completions(src: string, pos: Pos, fallback?: Analysis): CompletionEntry[] {
  const items: CompletionEntry[] = KEYWORDS.map((label) => ({ label, kind: "keyword" }));
  const scope = scopeAtPosition(src, pos, fallback);
  if (!scope) {
    for (const f of LIBRARY) items.push({ label: f.name, kind: "library", detail: signature(f), documentation: f.doc });
    return items;
  }
  for (const sym of visible(scope)) {
    const item: CompletionEntry = { label: sym.name, kind: sym.kind, detail: declarationText(sym) };
    const doc = libraryDoc(sym);
    if (doc) item.documentation = doc;
    items.push(item);
  }
  return items;
}
