import { strict as assert } from "assert";
import * as fs from "fs"; import * as path from "path";
import { parse } from "../../src/server/parser";
import { analyze, scopeAt, visible } from "../../src/server/scopes";
import { LIBRARY, signature } from "../../src/server/library";

const run = (s: string) => analyze(parse(s).program!);
const messages = (s: string) => run(s).diagnostics.map(d => d.message);
const repo = path.resolve(__dirname, "../../..");

describe("scopes", () => {
  it("finds undeclared names", () => {
    const a = run("m () : proc\n{ y = 1; }");
    assert.match(a.diagnostics[0].message, /Unknown name 'y'/);
  });
  it("finds duplicates and wrong argument counts", () => {
    const a = run("m () : proc\n x : int;\n x : byte;\n{ writeInteger(1, 2); }");
    const msgs = a.diagnostics.map(d => d.message).join("\n");
    assert.match(msgs, /already declared/);
    assert.match(msgs, /expects 1 argument/);
  });
  it("lists visible names at a position, innermost first", () => {
    const src = "m () : proc\n a : int;\n f (b : int) : proc\n  c : int;\n { c = b; }\n{ }";
    const a = run(src);
    const names = visible(scopeAt(a.root, { line: 4, character: 4 })).map(s => s.name);
    assert.deepEqual(names.slice(0, 5), ["c", "b", "f", "a", "m"]);
    assert.ok(names.includes("writeInteger"));
  });
  it("reports the errors in Examples/test2", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../../Examples/test2"), "utf8");
    const p = parse(src);
    const d = p.program ? analyze(p.program).diagnostics : [];
    assert.ok(p.diagnostics.length + d.length > 0);
  });

  const clean = [
    ...fs.readdirSync(path.join(repo, "Examples")).filter(f => f.endsWith(".alan")).map(f => `Examples/${f}`),
    "Examples/test", "tests/comments/comments.alan",
  ];
  for (const f of clean) {
    it(`finds no name errors in ${f}`, () => {
      const p = parse(fs.readFileSync(path.join(repo, f), "utf8"));
      assert.deepEqual(analyze(p.program!).diagnostics, []);
    });
  }

  it("reports the name error in tests/errors/undeclared.alan", () => {
    const d = run(fs.readFileSync(path.join(repo, "tests/errors/undeclared.alan"), "utf8")).diagnostics;
    assert.deepEqual(d.map(x => [x.message, x.range.start.line]), [["Unknown name 'y'", 2]]);
  });

  it("puts the exact messages on the name", () => {
    const d = run("m () : proc\n x : int;\n{ y = 1; x(); x[0] = 1; strcmp(x); }").diagnostics;
    assert.deepEqual(d.map(x => [x.message, x.range.start.character, x.range.end.character]), [
      ["Unknown name 'y'", 2, 3],
      ["'x' is not a function", 9, 10],
      ["'x' is not an array", 14, 15],
      ["'strcmp' expects 2 arguments but got 1", 24, 30],
    ]);
    assert.ok(d.every(x => x.severity === "error" && x.source === "alan"));
  });

  it("checks argument counts of user functions", () => {
    assert.deepEqual(messages("m () : proc\n f (a : int, b : int) : proc\n {}\n{ f(1); readInteger(1); }"), [
      "'f' expects 2 arguments but got 1",
      "'readInteger' expects 0 arguments but got 1",
    ]);
  });

  it("follows the compiler's scoping rules", () => {
    // Allowed: a local shadows an outer variable or function, recursion, calls to the enclosing function.
    assert.deepEqual(messages("m () : proc\n x : int;\n f () : proc\n  x : byte;\n  m : int;\n { x = 'a'; f(); }\n{ f(); }"), []);
    assert.deepEqual(messages("m () : proc\n f () : proc\n { m(); }\n{ f(); }"), []);
    // Allowed: a user function may reuse a library name, and then shadows it.
    assert.deepEqual(messages("m () : proc\n writeInteger (a : int, b : int) : proc\n {}\n{ writeInteger(1, 2); }"), []);
    // A parameter may not share the function's name, nor a local share a parameter's.
    assert.deepEqual(messages("m (m : int) : proc\n{}"), ["'m' is already declared in this scope"]);
    assert.deepEqual(messages("m () : proc\n f (a : int) : proc\n  a : int;\n {}\n{}"), ["'a' is already declared in this scope"]);
    // A nested function may not reuse any name visible where it is declared.
    assert.deepEqual(messages("m () : proc\n x : int;\n x () : proc\n {}\n{}"), ["'x' is already declared in this scope"]);
    assert.deepEqual(messages("m () : proc\n a : int;\n f () : proc\n  a () : proc\n  {}\n {}\n{}"),
      ["'a' is already declared in an enclosing function"]);
    assert.deepEqual(messages("m () : proc\n f () : proc\n {}\n f () : proc\n {}\n{}"), ["'f' is already declared in this scope"]);
  });

  it("sees only names declared before a nested function", () => {
    assert.deepEqual(messages("m () : proc\n f () : proc\n { x = 1; g(); }\n x : int;\n g () : proc\n {}\n{ x = 1; g(); }"),
      ["Unknown name 'x'", "Unknown name 'g'"]);
    const src = "m () : proc\n a : int;\n f () : proc\n { }\n b : int;\n{ }";
    const a = run(src);
    const inF = visible(scopeAt(a.root, { line: 3, character: 2 })).map(s => s.name);
    assert.ok(inF.includes("a") && !inF.includes("b"));
    const inM = visible(scopeAt(a.root, { line: 5, character: 1 })).map(s => s.name);
    assert.deepEqual(inM.slice(0, 4), ["b", "f", "a", "m"]);
  });

  it("keeps a function's nested functions out of the enclosing body", () => {
    assert.deepEqual(messages("m () : proc\n f () : proc\n  g () : proc\n  {}\n { g(); }\n{ g(); }"), ["Unknown name 'g'"]);
  });

  it("treats a function name used as a value like the compiler", () => {
    // Outside its own body the compiler does not find it. Inside, it accepts it.
    assert.deepEqual(messages("m () : proc\n x : int;\n f () : int\n { return 1; }\n{ x = f; x = writeInteger; }"),
      ["'f' is a function, not a variable", "'writeInteger' is a function, not a variable"]);
    assert.deepEqual(messages("m () : proc\n f () : int\n  x : int;\n { x = f; return 1; }\n{}"), []);
    assert.deepEqual(messages("m () : proc\n f () : int\n  x : int;\n { x = f[0]; return 1; }\n{}"), ["'f' is not an array"]);
  });

  it("records references with their targets", () => {
    const a = run("m () : proc\n x : int;\n{ x = 1; writeInteger(x); y = 2; }");
    assert.deepEqual(a.references.map(r => [r.name, r.range.start.character, r.target?.kind]), [
      ["x", 2, "variable"], ["writeInteger", 9, "library"], ["x", 22, "variable"], ["y", 26, undefined],
    ]);
    assert.deepEqual(a.references[0].target!.range, { start: { line: 1, character: 1 }, end: { line: 1, character: 2 } });
  });

  it("walks every kind of statement, expression and condition", () => {
    const src = "m () : proc\n a : int[3];\n{\n if (!(a[p] < q) & true | r == -s) t = (u + 'c') * 2;\n"
      + " else while (false) { a[v % w] = strlen(\"s\"); return x; }\n}";
    assert.deepEqual(parse(src).diagnostics, []);
    assert.deepEqual(messages(src), ["p", "q", "r", "s", "t", "u", "v", "w", "x"].map(n => `Unknown name '${n}'`));
  });

  it("describes symbols", () => {
    const a = run("m (n : int, s : reference byte[]) : byte\n v : int[4];\n{ }");
    const syms = new Map(visible(scopeAt(a.root, { line: 2, character: 1 })).map(s => [s.name, s]));
    assert.equal(syms.get("m")!.kind, "function");
    assert.equal(syms.get("m")!.typeText, "byte");
    assert.deepEqual(syms.get("m")!.params, [{ name: "n", type: "int" }, { name: "s", type: "reference byte[]" }]);
    assert.equal(syms.get("s")!.kind, "parameter");
    assert.equal(syms.get("s")!.typeText, "reference byte[]");
    assert.equal(syms.get("v")!.kind, "variable");
    assert.equal(syms.get("v")!.typeText, "int[4]");
    assert.equal(syms.get("strlen")!.kind, "library");
    assert.equal(syms.get("strlen")!.typeText, "int");
  });

  it("never throws on a broken tree", () => {
    const srcs = ["m (", "m (a : int, : proc\n{ a = ; if ( ) }", "m () : proc\n x : int[;\n{ x[ = 1; f(1,; }",
      "m () : proc\n f (\n{ while x", "m () : proc\n{ " + "a + ".repeat(20000) + "1; }",
      "m () : proc\n{ if (" + "true | ".repeat(20000) + "true) ; }"];
    for (const s of srcs) {
      const p = parse(s);
      if (p.program) analyze(p.program);
    }
  });

  it("scopeAt falls back to the root outside the program", () => {
    const a = run("m () : proc\n{ }");
    assert.equal(scopeAt(a.root, { line: 9, character: 0 }), a.root);
    assert.equal(scopeAt(a.root, { line: 1, character: 1 }).owner?.name, "m");
  });
});

describe("library", () => {
  it("has the 14 functions of the compiler", () => {
    assert.deepEqual(LIBRARY.map(f => f.name), ["writeInteger", "writeByte", "writeChar", "writeString",
      "readInteger", "readByte", "readChar", "readString", "extend", "shrink", "strlen", "strcmp", "strcpy", "strcat"]);
    assert.ok(LIBRARY.every(f => f.doc.length > 0));
  });
  it("prints signatures as Alan text", () => {
    const sig = (n: string) => signature(LIBRARY.find(f => f.name === n)!);
    assert.equal(sig("readString"), "readString (n : int, s : reference byte[]) : proc");
    assert.equal(sig("readInteger"), "readInteger () : int");
    assert.equal(sig("strcpy"), "strcpy (trg : reference byte[], src : reference byte[]) : proc");
    assert.equal(sig("shrink"), "shrink (i : int) : byte");
  });
});
