import { strict as assert } from "assert";
import * as fs from "fs"; import * as path from "path";
import { parse } from "../../src/server/parser";
import { analyze, scopeAt, visible } from "../../src/server/scopes";
import { LIBRARY, signature } from "../../src/server/library";

const run = (s: string) => analyze(parse(s).program!);
const messages = (s: string) => run(s).diagnostics.map(d => d.message);
/** Messages with their 1-based lines, as alanc prints them. */
const lines = (s: string) => run(s).diagnostics.map(d => `${d.range.start.line + 1}: ${d.message}`);
const repo = path.resolve(__dirname, "../../..");
/** A program whose main function holds the given lines, with x an int, b a byte and a an int[5]. */
const body = (...stmts: string[]) => ["m () : proc", " x : int;", " b : byte;", " a : int[5];", "{", ...stmts, "}"].join("\n");

describe("scopes", () => {
  it("finds undeclared names", () => {
    const a = run("m () : proc\n{ y = 1; }");
    assert.equal(a.diagnostics[0].message, "Identifier y not found.");
  });
  it("finds duplicates and wrong argument counts", () => {
    assert.deepEqual(messages("m () : proc\n x : int;\n x : byte;\n{ writeInteger(1, 2); }"), [
      "Duplicate identifier: x",
      "Error at Parameter writeInteger, there are too many Parameters.",
    ]);
  });
  it("lists visible names at a position, innermost first", () => {
    const src = "m () : proc\n a : int;\n f (b : int) : proc\n  c : int;\n { c = b; }\n{ }";
    const a = run(src);
    const names = visible(scopeAt(a.root, { line: 4, character: 4 })).map(s => s.name);
    assert.deepEqual(names.slice(0, 5), ["c", "b", "f", "a", "m"]);
    assert.ok(names.includes("writeInteger"));
  });
  it("reports the error in Examples/test2", () => {
    const src = fs.readFileSync(path.join(repo, "Examples/test2"), "utf8");
    assert.equal(lines(src)[0], "34: Error at Parameter n3, there must exist more Parameters.");
  });

  // papariatest.alan calls an int function as a statement, which is an error.
  const clean = [
    ...fs.readdirSync(path.join(repo, "Examples")).filter(f => f.endsWith(".alan") && f !== "papariatest.alan").map(f => `Examples/${f}`),
    "Examples/test", "tests/comments/comments.alan",
    ...fs.readdirSync(path.join(repo, "tests/regress")).filter(f => f.endsWith(".alan")).map(f => `tests/regress/${f}`),
  ];
  for (const f of clean) {
    it(`finds no errors in ${f}`, () => {
      const p = parse(fs.readFileSync(path.join(repo, f), "utf8"));
      assert.deepEqual(p.diagnostics, []);
      assert.deepEqual(analyze(p.program!).diagnostics, []);
    });
  }

  it("reports calling an int function as a statement in Examples/papariatest.alan", () => {
    assert.deepEqual(lines(fs.readFileSync(path.join(repo, "Examples/papariatest.alan"), "utf8")),
      ["15: Function paparia returns int, so it cannot be called as a statement."]);
  });

  it("puts the messages on the name or the part they are about", () => {
    const d = run("m () : proc\n x : int;\n{ y = 1; x(); x[0] = 1; writeString(x); }").diagnostics;
    assert.deepEqual(d.map(x => [x.message, x.range.start.character, x.range.end.character]), [
      ["Identifier y not found.", 2, 3],
      ["x is not a function.", 9, 10],
      ["Expected array.", 14, 15],
      ["s Parameter Type Mismatch (an array is expected).", 36, 37],
    ]);
    assert.ok(d.every(x => x.severity === "error" && x.source === "alan"));
  });

  it("checks argument counts like the compiler", () => {
    assert.deepEqual(messages("m () : proc\n f (a : int, b : int) : proc\n {}\n{ f(1); f(); writeChar(); readString(1, \"s\", 2); }"), [
      "Error at Parameter b, there must exist more Parameters.",
      "Function f must have Parameters.",
      "Function writeChar must have Parameters.",
      "Error at Parameter readString, there are too many Parameters.",
    ]);
    assert.deepEqual(messages("m () : proc\n x : int;\n{ x = readInteger(1); }"), ["Function readInteger cannot have any Parameters."]);
  });

  describe("Pascal scoping", () => {
    it("lets locals and nested functions shadow outer names", () => {
      assert.deepEqual(messages("m () : proc\n x : int;\n f () : proc\n  x : byte;\n  m : int;\n { x = 'a'; f(); }\n{ f(); }"), []);
      assert.deepEqual(messages("m () : proc\n f () : proc\n { m(); }\n{ f(); }"), []);
      assert.deepEqual(messages("m () : proc\n a : int;\n f () : proc\n  a () : proc\n  {}\n { a(); }\n{ a = 1; }"), []);
    });
    it("lets a parameter share its function's name", () => {
      assert.deepEqual(messages("m () : proc\n f (f : int) : int\n { return f + 1; }\n{ writeInteger(f(1)); }"), []);
    });
    it("lets a nested function reuse its parent's name", () => {
      assert.deepEqual(messages("m () : proc\n m () : proc { }\n{ m(); }"), []);
      assert.deepEqual(messages("m () : proc\n f () : proc\n  f () : proc { }\n { f(); }\n{ f(); }"), []);
    });
    it("lets a user function reuse a library name", () => {
      assert.deepEqual(messages("m () : proc\n writeInteger (a : int, b : int) : proc\n {}\n{ writeInteger(1, 2); }"), []);
    });
    it("reports a duplicate only within one scope, on the line of the header", () => {
      assert.deepEqual(lines("m () : proc\n f (a : int) : proc\n  a : int;\n {}\n{}"), ["3: Duplicate identifier: a"]);
      assert.deepEqual(lines("m () : proc\n x : int;\n x () : proc\n {}\n{}"), ["3: Duplicate identifier: x"]);
      assert.deepEqual(lines("m () : proc\n f () : proc\n {}\n f\n () :\n proc\n {}\n{}"), ["6: Duplicate identifier: f"]);
      assert.deepEqual(lines("m (a : int,\n a : byte) : proc\n{}"), [
        "2: The main function m cannot have parameters.", "2: Duplicate identifier: a",
      ]);
    });
    it("sees names declared before a nested function and its ancestors' earlier functions", () => {
      assert.deepEqual(messages("m () : proc\n f () : proc\n { x = 1; g(); }\n x : int;\n g () : proc\n {}\n{ x = 1; g(); }"),
        ["Identifier x not found.", "Function g is not declared in this Scope."]);
      assert.deepEqual(messages("m () : proc\n f () : proc { }\n g () : proc\n  h () : proc { f(); g(); }\n { h(); }\n{ g(); }"), []);
      const src = "m () : proc\n a : int;\n f () : proc\n { }\n b : int;\n{ }";
      const a = run(src);
      const inF = visible(scopeAt(a.root, { line: 3, character: 2 })).map(s => s.name);
      assert.ok(inF.includes("a") && inF.includes("f") && !inF.includes("b"));
      const inM = visible(scopeAt(a.root, { line: 5, character: 1 })).map(s => s.name);
      assert.deepEqual(inM.slice(0, 4), ["b", "f", "a", "m"]);
    });
    it("keeps a function's nested functions out of the enclosing body", () => {
      assert.deepEqual(messages("m () : proc\n f () : proc\n  g () : proc\n  {}\n { g(); }\n{ g(); }"),
        ["Function g is not declared in this Scope."]);
    });
    it("calls the library function when a user function of that name comes later", () => {
      assert.deepEqual(messages(fs.readFileSync(path.join(repo, "tests/regress/library_declared_later.alan"), "utf8")), []);
      const a = run("m () : proc\n g () : proc { writeInteger(1); }\n writeInteger (a : int, b : int) : proc { }\n{ writeInteger(1, 2); }");
      assert.deepEqual(a.diagnostics, []);
      assert.deepEqual(a.references.map(r => [r.name, r.target?.kind]), [["writeInteger", "library"], ["writeInteger", "function"]]);
    });
    it("gives a shadowing name a symbol of its own", () => {
      const a = run("m () : proc\n x : int;\n f (x : byte) : proc { x = 'a'; }\n{ x = 1; }");
      const [inner, outer] = a.references;
      assert.equal(inner.target!.kind, "parameter");
      assert.equal(outer.target!.kind, "variable");
      assert.notEqual(inner.target, outer.target);
    });
  });

  it("treats a function name used as a value like the compiler", () => {
    assert.deepEqual(messages("m () : proc\n x : int;\n f () : int\n { return 1; }\n{ x = f; x = writeInteger; }"),
      ["f is a function, so it needs arguments in parentheses.", "Identifier writeInteger not found."]);
    assert.deepEqual(messages("m () : proc\n f () : int\n  x : int;\n { x = f; return 1; }\n{}"),
      ["f is a function, so it needs arguments in parentheses."]);
    assert.deepEqual(messages("m () : proc\n f () : int\n  x : int;\n { x = f[0]; return 1; }\n{}"),
      ["f is a function, so it needs arguments in parentheses."]);
  });

  describe("types", () => {
    it("accepts int and byte where each belongs", () => {
      assert.deepEqual(messages(body("x = 1 + 2 * x;", "b = 'a';", "a[x] = a[0] % 3;", "b = shrink(x);",
        "x = extend(b) - -1;", "if (b == 'c' & x < 3 | !(a[1] >= 0)) writeByte(b);")), []);
    });
    it("checks assignments", () => {
      assert.deepEqual(messages(body("x = b;", "a = a;", "\"s\" = x;", "x = writeInteger(1);")), [
        "Can't assign different types (type int with type byte).",
        "Can't assign whole arrays or strings by = operator.",
        "Can't assign whole arrays or strings by = operator.",
        "Can't assign different types (type int with type void).",
      ]);
    });
    it("checks the operands of arithmetic and relational operators", () => {
      const p = "m () : proc\n p () : proc { }\n x : int;\n b : byte;\n a : int[5];\n{\n";
      assert.deepEqual(messages(`${p} x = x + b;\n x = a * 2;\n if (p() == p()) ;\n if (p() < 1) ;\n x = -b;\n}`), [
        "type mismatch in + operator (type int with type byte).",
        "type mismatch in * operator (can't use array in expression).",
        "type mismatch in == operator (operands must be int or byte, not proc).",
        "type mismatch in < operator (type proc with type int).",
        "type mismatch in - operator (type int with type byte).",
      ]);
    });
    it("checks array elements", () => {
      assert.deepEqual(messages(body("x = x[0];", "a[b] = 1;", "a[a] = 1;", "x = a[1];")), [
        "Expected array.", "Index of array must be an int.", "Index of array must be an int.",
      ]);
    });
    it("checks array declarations and parameters", () => {
      assert.deepEqual(lines("m () : proc\n a : int[0];\n f (v : int[]) : proc { }\n{ }"), [
        "2: Array size must be a positive int.",
        "3: In function f, array must be a reference parameter.",
      ]);
    });
    it("checks arguments", () => {
      const p = "m () : proc\n inc (x : reference int) : proc { x = x + 1; }\n h () : int { return 4; }\n"
        + " x : int;\n b : byte;\n a : int[5];\n s : byte[5];\n{\n";
      assert.deepEqual(messages(`${p} writeInteger(a);\n x = strlen(x);\n writeInteger(b);\n inc(h());\n inc(x + 1);\n`
        + ` inc((x));\n inc(a[2]);\n writeString("hi");\n writeString(s);\n strcpy(a, s);\n}`), [
        "n Parameter Type Mismatch (no arrays allowed).",
        "s Parameter Type Mismatch (an array is expected).",
        "n Parameter Type Mismatch (type byte with type int).",
        "Only L-values can be passed by reference (parameter x).",
        "Only L-values can be passed by reference (parameter x).",
        "trg Parameter Type Mismatch (type int with type byte).",
      ]);
    });
    it("checks returns", () => {
      const src = "m () : proc\n p () : proc { return; }\n q () : proc { return p(); }\n"
        + " f () : int\n  a : int[2];\n {\n  return;\n  return a;\n  return 'c';\n  return 1;\n }\n{ return; }";
      assert.deepEqual(lines(src), [
        "3: Function q is a proc, so its return cannot have a value.",
        "7: Function f must return int.",
        "8: Can't return whole array.",
        "9: Function f must return int.",
      ]);
    });
    it("reports calling a function with a result as a statement", () => {
      assert.deepEqual(messages("m () : proc\n f () : byte { return 'a'; }\n{ f(); readInteger(); writeInteger(1); }"), [
        "Function f returns byte, so it cannot be called as a statement.",
        "Function readInteger returns int, so it cannot be called as a statement.",
      ]);
    });
    it("reports the main function's parameters", () => {
      assert.deepEqual(lines("main (n : int) : proc\n{ writeInteger(n); }"), ["1: The main function main cannot have parameters."]);
    });
    it("reports only the first error of each expression", () => {
      assert.deepEqual(messages(body("x = y + x * 2 - q;")), ["Identifier y not found.", "Identifier q not found."]);
      assert.deepEqual(messages(body("x = b + x + x;")), ["type mismatch in + operator (type byte with type int)."]);
    });
    it("walks very long operator chains", () => {
      assert.deepEqual(messages(body(`x = ${"x + ".repeat(20000)}1;`, `if (${"x > 1 | ".repeat(20000)}true) ;`)), []);
    });
  });

  describe("lines", () => {
    it("gives a name the line of the token after it", () => {
      assert.deepEqual(lines(body("x = y", "  ;")), ["7: Identifier y not found."]);
      assert.deepEqual(lines(body("x = a[y", "  ];")), ["7: Identifier y not found."]);
    });
    it("gives an element, a call and a statement the line of their last token", () => {
      assert.deepEqual(lines(body("x = x[0", " ];")), ["7: Expected array."]);
      assert.deepEqual(lines(body("writeInteger(a", " );")), ["7: n Parameter Type Mismatch (no arrays allowed)."]);
      assert.deepEqual(lines(body("x", " =", " b", " ;")), ["9: Can't assign different types (type int with type byte)."]);
    });
    it("gives + and - the line of the token after them", () => {
      assert.deepEqual(lines(body("x = 1 + b", " ;")), ["7: type mismatch in + operator (type int with type byte)."]);
    });
    it("gives * the line after it only when its right operand is a name", () => {
      assert.deepEqual(lines(body("x = x * b", " ;")), ["7: type mismatch in * operator (type int with type byte)."]);
      assert.deepEqual(lines(body("x = b * 2", " ;")), ["6: type mismatch in * operator (type byte with type int)."]);
      assert.deepEqual(lines(body("x = -b", " ;")), ["7: type mismatch in - operator (type int with type byte)."]);
      assert.deepEqual(lines(body("x = -'a'", " ;")), ["6: type mismatch in - operator (type int with type byte)."]);
    });
    it("gives a comparison the line of the token after it", () => {
      assert.deepEqual(lines(body("if (x == b", " ) ;")), ["7: type mismatch in == operator (type int with type byte)."]);
    });
    it("gives a parameter the line of the token after its type, or of its ]", () => {
      assert.deepEqual(lines("m () : proc\n f (a : int\n , a : int) : proc { }\n{ }"), ["3: Duplicate identifier: a"]);
      assert.deepEqual(lines("m () : proc\n f (a : int[\n ]) : proc { }\n{ }"), ["3: In function f, array must be a reference parameter."]);
    });
    it("gives a variable the line of its semicolon", () => {
      assert.deepEqual(lines("m () : proc\n a : int[0]\n ;\n{ }"), ["3: Array size must be a positive int."]);
    });
    it("marks the token of that line when the name is on another one", () => {
      const d = run(body("x = y", "  ;")).diagnostics[0];
      assert.deepEqual(d.range, { start: { line: 6, character: 2 }, end: { line: 6, character: 3 } });
    });
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
    assert.deepEqual(messages(src), [
      ...["p", "q", "r", "s", "t", "u", "v", "w"].map(n => `Identifier ${n} not found.`),
      "Function m is a proc, so its return cannot have a value.",
      "Identifier x not found.",
    ]);
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
      "m () : proc\n{ if (" + "true | ".repeat(20000) + "true) ; }", "m () : proc\n f () : \n{ return 1; f(); }"];
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

  it("counts the position right after a nested function's closing brace as inside it", () => {
    const a = run("m () : proc\n f () : proc\n { }\n{ }");
    assert.equal(scopeAt(a.root, { line: 2, character: 3 }).owner?.name, "f");
    assert.equal(scopeAt(a.root, { line: 2, character: 4 }).owner?.name, "f");
    assert.equal(scopeAt(a.root, { line: 3, character: 0 }).owner?.name, "m");
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
