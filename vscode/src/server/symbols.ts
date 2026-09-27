// Go to definition and the document outline.
import { FuncDecl, VarDecl } from "./ast";
import { analyzeSource, symbolAt } from "./analysis";
import { Pos, Range } from "./lexer";
import { Task, run } from "./trampoline";

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

/**
 * Deepest nesting of functions the outline shows. The outline travels to
 * the editor as JSON, and JSON.stringify fails on trees about 1000 levels
 * deep. Functions below this depth are listed flat under the last one.
 */
const MAX_OUTLINE_DEPTH = 100;

function variable(v: VarDecl): OutlineSymbol {
  return { name: v.name, kind: "variable", range: v.range, selectionRange: v.nameRange, children: [] };
}

function entry(f: FuncDecl, children: OutlineSymbol[]): OutlineSymbol {
  return { name: f.name, kind: "function", range: f.range, selectionRange: f.nameRange, children };
}

/** Every function and variable inside f, in source order, each without children. */
function flat(f: FuncDecl): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  const todo: (FuncDecl | VarDecl)[] = [...f.locals].reverse();
  while (todo.length) {
    const local = todo.pop()!;
    if (local.kind === "var") { out.push(variable(local)); continue; }
    out.push(entry(local, []));
    for (let i = local.locals.length - 1; i >= 0; i--) todo.push(local.locals[i]);
  }
  return out;
}

/** The outline of a function. Functions may nest deeply, so this runs on trampoline.ts. */
function* outline(f: FuncDecl, depth: number): Task<OutlineSymbol> {
  if (depth >= MAX_OUTLINE_DEPTH) return entry(f, flat(f));
  const children: OutlineSymbol[] = [];
  for (const local of f.locals) {
    children.push(local.kind === "func" ? (yield outline(local, depth + 1)) as OutlineSymbol : variable(local));
  }
  return entry(f, children);
}

/** The functions and local variables of the file, nested as declared. */
export function documentSymbols(src: string): OutlineSymbol[] {
  const { program } = analyzeSource(src);
  return program ? [run(outline(program, 1))] : [];
}
