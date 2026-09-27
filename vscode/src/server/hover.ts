// Hover and signature help. Both show declarations in Alan syntax.
import { declarationText, libraryDoc, scopeAtPosition, symbolAt } from "./analysis";
import { Pos, lex } from "./lexer";
import { Analysis, visible } from "./scopes";

/** Markdown for the name at a position: its declaration, and the doc line of a library function. */
export function hover(src: string, pos: Pos): string | undefined {
  const sym = symbolAt(src, pos);
  if (!sym) return undefined;
  const code = "```alan\n" + declarationText(sym) + "\n```";
  const doc = libraryDoc(sym);
  return doc ? `${code}\n\n${doc}` : code;
}

export interface SignatureInfo {
  label: string;
  activeParameter: number;
  /** Start and end offsets of each parameter inside the label. */
  parameters: [number, number][];
  documentation?: string;
}

/**
 * Finds the call whose argument list holds the position by walking the
 * tokens before it backwards, so it also works in an unfinished call.
 */
function enclosingCall(src: string, pos: Pos): { name: string; argIndex: number } | undefined {
  const tokens = lex(src).tokens.filter((t) => t.kind !== "eof" && (
    t.range.end.line < pos.line || (t.range.end.line === pos.line && t.range.end.character <= pos.character)));
  let depth = 0;
  let commas = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const k = tokens[i].kind;
    if (k === ")" || k === "]") depth++;
    else if (k === "(" || k === "[") {
      if (depth > 0) { depth--; continue; }
      if (k === "(" && tokens[i - 1]?.kind === "id") return { name: tokens[i - 1].text, argIndex: commas };
      // An open index or grouping parenthesis: the call, if any, is further out.
      commas = 0;
    } else if (depth === 0) {
      if (k === ",") commas++;
      else if (k === ";" || k === "{" || k === "}") return undefined;
    }
  }
  return undefined;
}

export function signatureHelp(src: string, pos: Pos, fallback?: Analysis): SignatureInfo | undefined {
  const call = enclosingCall(src, pos);
  if (!call) return undefined;
  const scope = scopeAtPosition(src, pos, fallback);
  const sym = scope && visible(scope).find((s) => s.name === call.name);
  if (!sym || !sym.params) return undefined;

  const label = declarationText(sym);
  const parameters: [number, number][] = [];
  let at = sym.name.length + 2;                     // past "name ("
  for (const p of sym.params) {
    const text = `${p.name} : ${p.type}`;
    parameters.push([at, at + text.length]);
    at += text.length + 2;                          // past ", "
  }
  const info: SignatureInfo = { label, activeParameter: call.argIndex, parameters };
  const doc = libraryDoc(sym);
  if (doc) info.documentation = doc;
  return info;
}
