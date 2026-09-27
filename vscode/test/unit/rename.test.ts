import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { nameUnder, references, prepareRename, rename } from "../../src/server/rename";
import { analyzeSource } from "../../src/server/analysis";
import { Pos, Range } from "../../src/server/lexer";
import { Scope, Sym } from "../../src/server/scopes";

const src = [
  "m () : proc",
  " x : int;",
  " f () : proc",
  "  x : int;",
  " { x = 1; }",
  "{",
  " x = 2;",
  " f();",
  "}"].join("\n");

type Edit = { range: Range; newText: string };

function apply(text: string, edits: Edit[]): string {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  const at = (p: Pos) => starts[p.line] + p.character;
  let out = text;
  for (const e of [...edits].sort((a, b) => at(b.range.start) - at(a.range.start))) {
    out = out.slice(0, at(e.range.start)) + e.newText + out.slice(at(e.range.end));
  }
  return out;
}

function edited(text: string, pos: Pos, newName: string): string {
  const r = rename(text, pos, newName);
  assert.ok("edits" in r, "error" in r ? r.error : "");
  return apply(text, r.edits);
}

describe("rename", () => {
  it("finds references without crossing shadowing", () => {
    const r = references(src, { line: 6, character: 1 }, true);
    assert.deepEqual(r.map(x => x.start.line).sort(), [1, 6]);
  });
  it("renames the outer x only", () => {
    const r = rename(src, { line: 6, character: 1 }, "total") as any;
    assert.deepEqual(r.edits.map((e: any) => e.range.start.line).sort(), [1, 6]);
  });
  it("refuses keywords, library names and clashes", () => {
    assert.match((rename(src, { line: 6, character: 1 }, "while") as any).error, /keyword/);
    assert.match((prepareRename("m () : proc\n{ writeInteger(1); }", { line: 1, character: 3 }) as any).error, /Library/);
    assert.match((rename(src, { line: 6, character: 1 }, "f") as any).error, /clash/);
  });

  it("leaves out the declaration on request", () => {
    const r = references(src, { line: 6, character: 1 }, false);
    assert.deepEqual(r.map(x => x.start.line), [6]);
  });
  it("finds the inner x from its declaration", () => {
    const r = references(src, { line: 3, character: 2 }, true);
    assert.deepEqual(r.map(x => x.start.line), [3, 4]);
  });
  it("finds function references from a call", () => {
    const r = references(src, { line: 7, character: 2 }, true);
    assert.deepEqual(r.map(x => [x.start.line, x.start.character]), [[2, 1], [7, 1]]);
  });
  it("gives the name range under the cursor", () => {
    const s = nameUnder(src, { line: 6, character: 1 })!;
    assert.equal(s.sym.name, "x");
    assert.deepEqual(s.range, { start: { line: 6, character: 1 }, end: { line: 6, character: 2 } });
  });
  it("prepares a rename with the name as placeholder", () => {
    assert.deepEqual(prepareRename(src, { line: 2, character: 2 }),
      { range: { start: { line: 2, character: 1 }, end: { line: 2, character: 2 } }, placeholder: "f" });
  });
  it("refuses a position that is not on a name", () => {
    assert.match((prepareRename(src, { line: 5, character: 0 }) as any).error, /no name/);
    assert.match((rename(src, { line: 5, character: 0 }, "y") as any).error, /no name/);
  });
  it("refuses documents with syntax errors", () => {
    const bad = "m () : proc\n x : int;\n{ x = ; }";
    assert.match((prepareRename(bad, { line: 1, character: 1 }) as any).error, /syntax/);
    assert.match((rename(bad, { line: 1, character: 1 }, "y") as any).error, /syntax/);
  });
  it("refuses names that are not identifiers", () => {
    for (const bad of ["", "1x", "_x", "a-b", "a b", "é"]) {
      assert.match((rename(src, { line: 6, character: 1 }, bad) as any).error, /not a valid name/, bad);
    }
    assert.equal((rename(src, { line: 6, character: 1 }, "while") as any).error, "'while' is a keyword.");
  });
  it("refuses renaming a library function through rename too", () => {
    assert.match((rename("m () : proc\n{ writeInteger(1); }", { line: 1, character: 3 }, "w") as any).error, /Library/);
  });
  it("names the line of the declaration it would clash with", () => {
    assert.equal((rename(src, { line: 6, character: 1 }, "f") as any).error, "'f' would clash with the declaration at line 3.");
  });
  it("refuses a name that would capture a use of an outer name", () => {
    const s = ["m () : proc", " y : int;", " g () : proc", "  x : int;", " { x = 1; y = 2; }", "{ y = 3; }"].join("\n");
    // Renaming the inner x to y would make the use of the outer y in g find the inner one.
    assert.equal((rename(s, { line: 3, character: 2 }, "y") as any).error, "'y' would clash with the declaration at line 2.");
  });
  it("refuses a name that an inner declaration would capture", () => {
    const s = ["m () : proc", " x : int;", " g () : proc", "  y : int;", " { y = 1; x = 2; }", "{ x = 3; }"].join("\n");
    assert.equal((rename(s, { line: 1, character: 1 }, "y") as any).error, "'y' would clash with the declaration at line 4.");
  });
  it("refuses a parameter named like its function", () => {
    const s = "m () : proc\n g (a : int) : proc { a = 1; }\n{ g(1); }";
    assert.match((rename(s, { line: 1, character: 4 }, "g") as any).error, /clash/);
    assert.match((rename(s, { line: 1, character: 1 }, "a") as any).error, /clash/);
  });
  it("refuses a nested function named like a name of an enclosing function", () => {
    const s = "m () : proc\n z : int;\n g () : proc { }\n{ z = 1; g(); }";
    assert.match((rename(s, { line: 2, character: 1 }, "z") as any).error, /clash/);
    assert.match((rename(s, { line: 2, character: 1 }, "m") as any).error, /clash/);
  });
  it("renames a user function to a library name when the compiler accepts it", () => {
    const s = "m () : proc\n g (a : int) : proc { }\n{ g(1); }";
    assert.equal(edited(s, { line: 2, character: 2 }, "writeInteger"),
      "m () : proc\n writeInteger (a : int) : proc { }\n{ writeInteger(1); }");
  });
  it("refuses a library name that a use of the library function would then find", () => {
    const s = "m () : proc\n x : int;\n{ x = 1; writeInteger(x); }";
    assert.match((rename(s, { line: 1, character: 1 }, "writeInteger") as any).error, /clash with the library function 'writeInteger'/);
  });
  it("renames a recursive function everywhere", () => {
    const s = "m () : proc\n f (n : int) : int { return f(n - 1); }\n{ writeInteger(f(3)); }";
    assert.equal(edited(s, { line: 1, character: 28 }, "down"),
      "m () : proc\n down (n : int) : int { return down(n - 1); }\n{ writeInteger(down(3)); }");
  });
  it("renames an indexed array and a variable to a longer name on the same line", () => {
    const s = "m () : proc\n a : int[3];\n i : int;\n{ i = 0; a[i] = a[i] + i; }";
    assert.equal(edited(s, { line: 2, character: 1 }, "index"),
      "m () : proc\n a : int[3];\n index : int;\n{ index = 0; a[index] = a[index] + index; }");
  });
  it("renames a function called from a nested function", () => {
    const s = "m () : proc\n f () : proc { }\n g () : proc\n { f(); }\n{ f(); g(); }";
    assert.equal(edited(s, { line: 1, character: 1 }, "h"),
      "m () : proc\n h () : proc { }\n g () : proc\n { h(); }\n{ h(); g(); }");
    assert.match((rename(s, { line: 3, character: 3 }, "g") as any).error, /clash/);
  });
  it("renames a nested parameter that shadows an outer variable of the same name", () => {
    const s = "m () : proc\n x : int;\n g (x : int) : proc { x = 1; }\n{ x = 2; g(x); }";
    assert.equal(edited(s, { line: 2, character: 4 }, "y"),
      "m () : proc\n x : int;\n g (y : int) : proc { y = 1; }\n{ x = 2; g(x); }");
    assert.equal(edited(s, { line: 3, character: 2 }, "y"),
      "m () : proc\n y : int;\n g (x : int) : proc { x = 1; }\n{ y = 2; g(y); }");
  });
  it("renames 30,000 uses in a 5,000 line file quickly", () => {
    const lines = ["m () : proc", " x : int;", " y : int;", "{"];
    for (let i = 0; i < 5000; i++) lines.push(" x = x + y; x = x + y; x = x + y;");
    lines.push("}");
    const big = lines.join("\n");
    // The fastest of 5 runs, so a busy machine does not fail the test.
    const fastest = (newName: string) => {
      let ms = Infinity;
      for (let i = 0; i < 5; i++) {
        const t0 = process.hrtime.bigint();
        rename(big, { line: 1, character: 1 }, newName);
        ms = Math.min(ms, Number(process.hrtime.bigint() - t0) / 1e6);
      }
      return ms;
    };
    const r = rename(big, { line: 1, character: 1 }, "total");
    assert.ok("edits" in r && r.edits.length === 30001);
    const accepted = fastest("total");
    assert.ok(accepted < 1000, `took ${accepted.toFixed(1)} ms`);
    assert.ok("error" in rename(big, { line: 1, character: 1 }, "m"));
    const refused = fastest("m");
    assert.ok(refused < 1000, `took ${refused.toFixed(1)} ms`);
  });
  it("returns no edits for the same name", () => {
    assert.deepEqual(rename(src, { line: 6, character: 1 }, "x"), { edits: [] });
  });
});

// Fuzz: random renames in the examples either are refused or keep the
// analysis clean and every use pointing at the same declaration.
const examples = path.join(__dirname, "..", "..", "..", "Examples");

function declarationsInOrder(root: Scope): Sym[] {
  const out = new Set<Sym>();
  const stack = [root];
  while (stack.length) {
    const s = stack.pop()!;
    for (const sym of s.symbols.values()) if (sym.range) out.add(sym);
    stack.push(...s.children);
  }
  const cmp = (a: Pos, b: Pos) => a.line - b.line || a.character - b.character;
  return [...out].sort((a, b) => cmp(a.range!.start, b.range!.start));
}

/** Uses in walk order, each as the index of its declaration in source order. */
function shape(text: string) {
  const { analysis, clean } = analyzeSource(text);
  assert.ok(analysis && clean);
  const decls = declarationsInOrder(analysis.root);
  const refs = analysis.references.map(r => !r.target ? "unknown" : r.target.range ? String(decls.indexOf(r.target)) : `lib ${r.name}`);
  const diagnostics = analysis.diagnostics.map(d => `${d.code} ${d.range.start.line}`);
  return { decls: decls.length, refs, diagnostics };
}

describe("rename fuzz", () => {
  let seed = 12345;
  const random = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const pools = ["while", "int", "writeInteger", "strlen", "readInteger", "main", "x", "i", "n", "tmp", "a1", "z_9", "1bad", "_u"];
  let accepted = 0;
  let refused = 0;

  for (const f of fs.readdirSync(examples).filter(f => f.endsWith(".alan"))) {
    it(`keeps the meaning of ${f}`, () => {
      const text = fs.readFileSync(path.join(examples, f), "utf8");
      const { analysis, clean } = analyzeSource(text);
      if (!analysis || !clean) return;
      const before = shape(text);
      const decls = declarationsInOrder(analysis.root);
      const spots = [...decls.map(d => d.range!), ...analysis.references.map(r => r.range)];
      const names = [...pools, ...decls.map(d => d.name)];
      for (let k = 0; k < 40; k++) {
        const spot = spots[random(spots.length)];
        const newName = names[random(names.length)];
        const r = rename(text, spot.start, newName);
        if ("error" in r) {
          refused++;
          continue;
        }
        accepted++;
        const after = shape(apply(text, r.edits));
        assert.equal(after.decls, before.decls, `${f}: ${newName}`);
        assert.deepEqual(after.refs, before.refs, `${f}: ${newName}`);
        for (const d of after.diagnostics) assert.ok(before.diagnostics.includes(d), `${f}: ${newName} adds ${d}`);
      }
    });
  }

  it("both accepts and refuses renames", () => {
    assert.ok(accepted > 50, `accepted ${accepted}`);
    assert.ok(refused > 50, `refused ${refused}`);
  });
});
