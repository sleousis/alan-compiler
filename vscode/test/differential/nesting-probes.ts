// Programs at the nesting limits of the compiler, 3000 and 3001 levels of
// each kind that counts and of some that do not. They are too big to keep
// in the repository, so the differential test writes them to a folder.
// One construct per line, so a wrong line shows.
import * as fs from "node:fs";
import * as path from "node:path";

const HEAD = "main () : proc\n  x : int;\n  a : int[5];\n  f (n : int) : int { return n; }\n  p () : proc { }\n{\n";
const TAIL = "}\n";

const lines = (n: number, line: string) => `${line}\n`.repeat(n);

/** Kinds of nesting, each a program for n levels. */
export const KINDS: Record<string, (n: number) => string> = {
  ifs: (n) => `${HEAD}${lines(n, "  if (x > 0)")}  x = 1;\n${TAIL}`,
  whiles: (n) => `${HEAD}${lines(n, "  while (x > 0)")}  x = 1;\n${TAIL}`,
  else_ifs: (n) => `${HEAD}  if (x > 0) x = 1;\n${lines(n - 1, "  else if (x > 1) x = 2;")}${TAIL}`,
  blocks: (n) => `${HEAD}${lines(n, "  {")}  x = 1;\n${lines(n, "  }")}${TAIL}`,
  if_blocks: (n) => `${HEAD}${lines(n / 2, "  if (x > 0) {")}  x = 1;\n${lines(n / 2, "  }")}${TAIL}`,
  nots: (n) => `${HEAD}  if (\n${lines(n, "    !")}    true) ;\n${TAIL}`,
  not_compare: (n) => `${HEAD}  if (\n${lines(n - 1, "    !")}    x == 1) ;\n${TAIL}`,
  right_plus: (n) => `${HEAD}  x =\n${lines(n, "    x + (")}    1${")".repeat(n)};\n${TAIL}`,
  right_and: (n) => `${HEAD}  if (\n${lines(n, "    true & (")}    true${")".repeat(n)}) ;\n${TAIL}`,
  unary_minus: (n) => `${HEAD}  x =\n${lines(n, "    -")}    1;\n${TAIL}`,
  calls: (n) => `${HEAD}  x =\n${lines(n, "    f(")}    1${")".repeat(n)};\n${TAIL}`,
  call_statement: (n) => `${HEAD}  writeInteger(\n${lines(n - 1, "    f(")}    1${")".repeat(n - 1)});\n${TAIL}`,
  indexes: (n) => `${HEAD}  x =\n${lines(n, "    a[")}    0${"]".repeat(n)};\n${TAIL}`,
  functions: (n) => `main () : proc\n${lines(n, "  g () : proc")}${lines(n + 1, "  { }")}`,
};

/** Kinds that never count, at a depth far past the limit. */
export const UNCOUNTED: Record<string, string> = {
  left_plus: `${HEAD}  x =\n${lines(5000, "    (")}    1\n${lines(5000, "    + x)")};\n${TAIL}`,
  left_and: `${HEAD}  if (\n    true\n${lines(5000, "    & true")}    ) ;\n${TAIL}`,
  parentheses: `${HEAD}  x = ${"(".repeat(5000)}1${")".repeat(5000)};\n${TAIL}`,
};

/** Writes the probes to dir and returns their paths. */
export function writeNestingProbes(dir: string): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  const write = (name: string, text: string) => {
    const file = path.join(dir, `${name}.alan`);
    fs.writeFileSync(file, text);
    out.push(file);
  };
  for (const [kind, make] of Object.entries(KINDS)) {
    write(`nesting_${kind}_3000`, make(3000));
    write(`nesting_${kind}_3001`, make(kind === "if_blocks" ? 3002 : 3001));
  }
  for (const [kind, text] of Object.entries(UNCOUNTED)) write(`nesting_${kind}`, text);
  return out;
}
