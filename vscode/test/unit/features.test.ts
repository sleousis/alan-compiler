import { strict as assert } from "assert";
import {
  analyzeSource, completions, computeDiagnostics, definition, documentSymbols, firstError, hover, mergeDiagnostics,
  references, signatureHelp,
} from "../../src/server/features";

const src = "m () : proc\n total : int;\n add (a : int, b : int) : int\n { return a + b; }\n{\n  total = add(1, 2);\n  \n}";

describe("features", () => {
  it("completes keywords, locals, functions and library", () => {
    const labels = completions(src, { line: 6, character: 2 }).map(c => c.label);
    for (const l of ["total", "add", "m", "writeInteger", "while", "if"]) assert.ok(labels.includes(l), l);
  });
  it("hovers a function with its signature", () => {
    assert.match(hover(src, { line: 5, character: 11 })!, /add \(a : int, b : int\) : int/);
  });
  it("shows signature help with the active parameter", () => {
    const s = signatureHelp(src, { line: 5, character: 16 })!;
    assert.equal(s.activeParameter, 1);
  });
  it("goes to the definition", () => {
    assert.equal(definition(src, { line: 5, character: 3 })!.start.line, 1);
  });
  it("outlines nested functions", () => {
    const d = documentSymbols(src);
    assert.equal(d[0].name, "m");
    assert.ok(d[0].children.some((c: any) => c.name === "add"));
  });
});

describe("diagnostics", () => {
  const messages = (s: string) => computeDiagnostics(s).map(d => d.message);

  it("reports the compiler's errors once the syntax is clean", () => {
    const m = messages("m () : proc\n f (a : int) : proc\n {}\n z : int;\n{ y = 1; f(); z = f; }");
    assert.deepEqual(m, [
      "Identifier y not found.",
      "Function f must have Parameters.",
      "f is a function, so it needs arguments in parentheses.",
    ]);
  });
  it("keeps syntax errors and errors of declarations but hides the others while the syntax is broken", () => {
    const m = messages("m () : proc\n x : int;\n x : byte;\n a : int[0];\n f (a : int) : proc\n {}\n{ y = 1; f(); z = f; x = 'a'; x = ; }");
    assert.ok(m.includes("Duplicate identifier: x"), "duplicate");
    assert.ok(m.includes("Array size must be a positive int."), "declaration");
    assert.ok(m.some(x => /expected an expression/.test(x)), "syntax");
    assert.ok(!m.some(x => /not found|Parameters|is a function|assign/.test(x)), m.join("\n"));
  });
  it("gives each semantic error a code", () => {
    const d = computeDiagnostics("m () : proc\n x : int;\n x : int;\n f (a : int) : proc\n {}\n{ y = 1; f(); x = f; x[0] = 1; x(); x = 'a'; }");
    assert.deepEqual(d.map(x => x.code),
      ["duplicate", "unknown-name", "argument-count", "not-a-variable", "not-an-array", "not-a-function", "type"]);
    assert.deepEqual(computeDiagnostics("m (n : int) : proc\n{ }").map(x => x.code), ["declaration"]);
  });
  it("finds the error the compiler reports first", () => {
    assert.equal(firstError("m () : proc\n{ y = 1; }")!.message, "Identifier y not found.");
    // The compiler meets the call before the duplicate that comes earlier in the text.
    assert.equal(firstError("m () : proc\n f () : proc { g(); }\n x : int;\n x : int;\n{ }")!.message,
      "Function g is not declared in this Scope.");
    assert.equal(firstError("m () : proc\n{ y = 1; x = 'ab'; }")!.message, "Invalid character constant");
    assert.equal(firstError("m () : proc\n{ }"), undefined);
  });
  it("accepts a text already analysed", () => {
    const text = "m () : proc\n{ y = 1; }";
    assert.deepEqual(computeDiagnostics(analyzeSource(text)), computeDiagnostics(text));
  });
  it("reports lexer errors", () => {
    assert.ok(messages("m () : proc\n{ writeChar('ab'); }").includes("Invalid character constant"));
  });
  it("returns nothing for a clean file", () => {
    assert.deepEqual(computeDiagnostics(src), []);
  });
  it("drops compiler diagnostics on lines that have a live one", () => {
    const at = (line: number, message: string) =>
      ({ message, range: { start: { line, character: 0 }, end: { line, character: 1 } } });
    const merged = mergeDiagnostics([at(1, "live")], [at(1, "compiler 1"), at(2, "compiler 2")]);
    assert.deepEqual(merged.map(d => d.message), ["live", "compiler 2"]);
  });
});

describe("completion", () => {
  it("offers exactly the Alan keywords", () => {
    const kw = completions(src, { line: 6, character: 2 }).filter(c => c.kind === "keyword").map(c => c.label);
    assert.deepEqual(kw.sort(), ["byte", "else", "false", "if", "int", "proc", "reference", "return", "true", "while"]);
  });
  it("describes library functions with their signature and doc line", () => {
    const w = completions(src, { line: 6, character: 2 }).find(c => c.label === "readString")!;
    assert.equal(w.kind, "library");
    assert.equal(w.detail, "readString (n : int, s : reference byte[]) : proc");
    assert.equal(w.documentation, "Reads a line of at most n - 1 characters into s.");
  });
  it("describes locals, parameters and functions", () => {
    const inAdd = completions(src, { line: 3, character: 10 });
    const a = inAdd.find(c => c.label === "a")!;
    assert.equal(a.kind, "parameter");
    assert.equal(a.detail, "a : int");
    const inM = completions(src, { line: 6, character: 2 });
    assert.equal(inM.find(c => c.label === "total")!.kind, "variable");
    assert.equal(inM.find(c => c.label === "add")!.detail, "add (a : int, b : int) : int");
  });
  it("still completes locals while the current text has a syntax error", () => {
    const broken = "m () : proc\n total : int;\n{\n  total = ;\n  \n}";
    const labels = completions(broken, { line: 4, character: 2 }).map(c => c.label);
    assert.ok(labels.includes("total"));
  });
  it("falls back to the last good analysis when the current text gives no tree", () => {
    const good = analyzeSource(src);
    assert.equal(good.clean, true);
    const labels = completions("{", { line: 0, character: 1 }, good.analysis).map(c => c.label);
    assert.ok(labels.includes("total"));
  });
  it("ignores a stale fallback when the current text is clean", () => {
    const stale = analyzeSource(src).analysis;
    const labels = completions("m () : proc\n x : int;\n{ x = 1; }\n    ", { line: 3, character: 4 }, stale).map(c => c.label);
    for (const l of ["a", "b", "add", "total"]) assert.ok(!labels.includes(l), l);
    const inside = completions("m () : proc\n x : int;\n{ x = 1; }", { line: 2, character: 2 }, stale).map(c => c.label);
    assert.ok(inside.includes("x") && !inside.includes("total"));
  });
  it("takes only the outermost function's names from the fallback", () => {
    const labels = completions("{", { line: 3, character: 4 }, analyzeSource(src).analysis).map(c => c.label);
    assert.ok(labels.includes("total") && labels.includes("add"));
    assert.ok(!labels.includes("a") && !labels.includes("b"));
  });
  it("offers keywords and the library without any tree", () => {
    const labels = completions("", { line: 0, character: 0 }).map(c => c.label);
    assert.ok(labels.includes("while") && labels.includes("writeInteger"));
  });
});

describe("hover", () => {
  it("shows a variable declaration in Alan syntax", () => {
    assert.match(hover("m () : proc\n x : int[4];\n{ x[0] = 1; }", { line: 2, character: 2 })!, /x : int\[4\]/);
  });
  it("shows a reference parameter", () => {
    const s = "m () : proc\n swap (a : reference int, b : reference int) : proc\n { a = b; }\n{ }";
    assert.match(hover(s, { line: 2, character: 3 })!, /a : reference int/);
    assert.match(hover(s, { line: 1, character: 2 })!, /swap \(a : reference int, b : reference int\) : proc/);
  });
  it("shows the doc line of a library function", () => {
    const h = hover("m () : proc\n{ writeInteger(1); }", { line: 1, character: 4 })!;
    assert.match(h, /writeInteger \(n : int\) : proc/);
    assert.match(h, /Prints an integer\./);
  });
  it("shows nothing away from a name", () => {
    assert.equal(hover(src, { line: 5, character: 8 }), undefined);
  });
});

describe("signature help", () => {
  it("works in an unfinished library call", () => {
    const s = signatureHelp("m () : proc\n{ strcmp(\"a\", ", { line: 1, character: 14 })!;
    assert.equal(s.label, "strcmp (s1 : reference byte[], s2 : reference byte[]) : int");
    assert.equal(s.activeParameter, 1);
  });
  it("picks the innermost call", () => {
    const s = signatureHelp("m () : proc\n{ writeInteger(extend(", { line: 1, character: 22 })!;
    assert.match(s.label, /^extend /);
    assert.equal(s.activeParameter, 0);
  });
  it("ignores commas inside nested parentheses and indexes", () => {
    const s = signatureHelp(src, { line: 5, character: 15 })!;
    assert.equal(s.activeParameter, 0);
    const t = signatureHelp("m () : proc\n{ strcpy(x[(1)], ", { line: 1, character: 17 })!;
    assert.equal(t.activeParameter, 1);
  });
  it("gives the offsets of each parameter in the label", () => {
    const s = signatureHelp(src, { line: 5, character: 14 })!;
    assert.deepEqual(s.parameters.map(([a, b]) => s.label.slice(a, b)), ["a : int", "b : int"]);
  });
  it("gives nothing in the parameter list of a function header", () => {
    assert.equal(signatureHelp("m () : proc\n f (a : int, ", { line: 1, character: 13 }), undefined);
    assert.equal(signatureHelp("m (", { line: 0, character: 3 }), undefined);
    assert.equal(signatureHelp(src, { line: 2, character: 6 }), undefined);
  });
  it("gives nothing outside a call", () => {
    assert.equal(signatureHelp(src, { line: 5, character: 20 }), undefined);
    assert.equal(signatureHelp(src, { line: 6, character: 2 }), undefined);
  });
});

describe("Pascal scoping in the editor", () => {
  const nested = [
    "m () : proc",            // 0
    " x : int;",              // 1
    " f (f : int) : int",     // 2
    " { return f + x; }",     // 3
    " g () : proc",           // 4
    "  x : byte;",            // 5
    "  m () : proc { }",      // 6
    " { x = 'a'; m(); }",     // 7
    " y : int;",              // 8
    "{ x = f(1); g(); }",     // 9
  ].join("\n");

  it("completes a parameter that shares its function's name as the parameter", () => {
    const f = completions(nested, { line: 3, character: 10 }).filter(c => c.label === "f");
    assert.deepEqual(f.map(c => [c.kind, c.detail]), [["parameter", "f : int"]]);
  });
  it("completes the innermost of shadowing names and only names declared before", () => {
    const items = completions(nested, { line: 7, character: 3 });
    assert.equal(items.find(c => c.label === "x")!.detail, "x : byte");
    assert.equal(items.find(c => c.label === "m")!.detail, "m () : proc");
    assert.equal(items.filter(c => c.label === "m").length, 1);
    assert.ok(items.some(c => c.label === "f") && !items.some(c => c.label === "y"));
  });
  it("hovers and goes to the declaration that a shadowing name finds", () => {
    assert.match(hover(nested, { line: 7, character: 3 })!, /x : byte/);
    assert.deepEqual(definition(nested, { line: 7, character: 3 })!.start, { line: 5, character: 2 });
    assert.deepEqual(definition(nested, { line: 7, character: 12 })!.start, { line: 6, character: 2 });
    assert.deepEqual(definition(nested, { line: 3, character: 10 })!.start, { line: 2, character: 4 });
    assert.deepEqual(definition(nested, { line: 9, character: 6 })!.start, { line: 2, character: 1 });
  });
  it("keeps the uses of a shadowed name apart", () => {
    const outer = references(nested, { line: 1, character: 1 }, true).map(r => r.start);
    assert.deepEqual(outer, [{ line: 1, character: 1 }, { line: 3, character: 14 }, { line: 9, character: 2 }]);
  });
  it("gives a call the library function when the user function comes later", () => {
    const src = "m () : proc\n g () : proc { writeInteger(1); }\n writeInteger (a : int, b : int) : proc { }\n{ writeInteger(1, 2); }";
    assert.match(hover(src, { line: 1, character: 16 })!, /Prints an integer/);
    assert.deepEqual(definition(src, { line: 3, character: 3 })!.start, { line: 2, character: 1 });
    assert.equal(signatureHelp(src, { line: 1, character: 28 })!.label, "writeInteger (n : int) : proc");
  });
});

describe("definition and outline", () => {
  it("finds a parameter and a function, but not a library function", () => {
    assert.deepEqual(definition(src, { line: 3, character: 10 })!.start, { line: 2, character: 6 });
    assert.deepEqual(definition(src, { line: 5, character: 12 })!.start, { line: 2, character: 1 });
    assert.equal(definition("m () : proc\n{ writeInteger(1); }", { line: 1, character: 4 }), undefined);
  });
  it("lists variables and functions with their ranges", () => {
    const [m] = documentSymbols(src);
    assert.deepEqual(m.children.map((c: any) => [c.name, c.kind]), [["total", "variable"], ["add", "function"]]);
    assert.deepEqual(m.selectionRange, { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } });
    assert.equal(m.range.end.line, 7);
  });
  it("returns nothing without a tree", () => {
    assert.deepEqual(documentSymbols(""), []);
  });
});
