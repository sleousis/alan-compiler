// Go to definition and the document outline.
import { FuncDecl } from "./ast";
import { symbolAt } from "./analysis";
import { Pos, Range } from "./lexer";
import { parse } from "./parser";

/** The range of the declaration of the name at a position. Library functions have none. */
export function definition(src: string, pos: Pos): Range | undefined {
  return symbolAt(src, pos)?.range;
}

export interface OutlineSymbol {
  name: string;
  kind: "function" | "variable";
  range: Range;
  selectionRange: Range;
  children: OutlineSymbol[];
}

function outline(f: FuncDecl): OutlineSymbol {
  const children = f.locals.map((local): OutlineSymbol => local.kind === "func"
    ? outline(local)
    : { name: local.name, kind: "variable", range: local.range, selectionRange: local.nameRange, children: [] });
  return { name: f.name, kind: "function", range: f.range, selectionRange: f.nameRange, children };
}

/** The functions and local variables of the file, nested as declared. */
export function documentSymbols(src: string): OutlineSymbol[] {
  const { program } = parse(src);
  return program ? [outline(program)] : [];
}
