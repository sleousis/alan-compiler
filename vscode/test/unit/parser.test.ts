import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { parse } from "../../src/server/parser";

const ex = path.resolve(__dirname, "../../../Examples");

describe("parser", () => {
  for (const f of fs.readdirSync(ex).filter(f => f.endsWith(".alan"))) {
    it(`parses ${f} without errors`, () => {
      const r = parse(fs.readFileSync(path.join(ex, f), "utf8"));
      assert.deepEqual(r.diagnostics, []);
      assert.ok(r.program);
    });
  }
  it("reports a missing semicolon at the end of the statement", () => {
    const r = parse("main () : proc\n x : int;\n{\n  x = 1\n  x = 2;\n}");
    assert.equal(r.diagnostics.length, 1);
    assert.equal(r.diagnostics[0].range.start.line, 3);
    assert.match(r.diagnostics[0].message, /';'/);
  });
  it("keeps going after an error", () => {
    const r = parse("main () : proc\n{\n  x = ;\n  y = ;\n}");
    assert.equal(r.diagnostics.length, 2);
  });
  it("parses parenthesised conditions and expressions", () => {
    const r = parse("m () : proc\n x : int;\n{ if ((x + 1) * 2 > 3 & !(x == 0) | true) ; }");
    assert.deepEqual(r.diagnostics, []);
  });
  it("parses nested functions", () => {
    const r = parse("a () : proc\n b (x : reference int, y : byte[]) : int\n { return x; }\n{ }");
    assert.equal(r.program!.locals[0].kind, "func");
  });

  it("parses tests/comments/comments.alan without errors", () => {
    const r = parse(fs.readFileSync(path.resolve(__dirname, "../../../tests/comments/comments.alan"), "utf8"));
    assert.deepEqual(r.diagnostics, []);
  });

  const body = (stmt: string) => parse(`m () : proc\n x : int;\n{ ${stmt} }`);
  const firstStmt = (stmt: string): any => body(stmt).program!.body.stmts[0];

  it("gives * precedence over + and binds unary minus tightest", () => {
    const s = firstStmt("x = -x + 2 * 3;");
    assert.equal(s.value.op, "+");
    assert.equal(s.value.left.kind, "unary");
    assert.equal(s.value.right.op, "*");
  });
  it("makes + and - left associative", () => {
    const s = firstStmt("x = 1 - 2 - 3;");
    assert.equal(s.value.left.op, "-");
    assert.equal(s.value.right.value, 3);
  });
  it("binds & tighter than | and ! tighter than both", () => {
    const s = firstStmt("if (true | !false & x < 1) ;");
    assert.equal(s.cond.op, "|");
    assert.equal(s.cond.right.op, "&");
    assert.equal(s.cond.right.left.kind, "not");
    assert.equal(s.cond.right.right.kind, "compare");
  });
  it("binds else to the nearest if", () => {
    const s = firstStmt("if (true) if (false) ; else x = 1;");
    assert.equal(s.else, undefined);
    assert.equal(s.then.else.kind, "assign");
  });
  it("reads a parenthesised expression at the start of a comparison", () => {
    const s = firstStmt("while ((x) + 1 >= (2)) ;");
    assert.equal(s.cond.kind, "compare");
    assert.equal(s.cond.left.op, "+");
  });
  it("gives node ranges from first to last token", () => {
    const s = firstStmt("x = (1 + 2) * 3;");
    assert.deepEqual(s.range, { start: { line: 2, character: 2 }, end: { line: 2, character: 18 } });
    assert.deepEqual(s.value.range.start, { line: 2, character: 6 });
  });
  it("records declarations, array sizes and reference parameters", () => {
    const r = parse("m (a : reference byte[]) : int\n v : byte[10];\n{ return 0; }");
    const p = r.program!;
    assert.deepEqual(r.diagnostics, []);
    assert.deepEqual([p.params[0].byRef, p.params[0].type.base, p.params[0].type.array], [true, "byte", true]);
    assert.equal(p.ret, "int");
    assert.deepEqual([p.locals[0].kind, (p.locals[0] as any).size], ["var", 10]);
  });
  it("includes lexer errors once and goes on after a bad token", () => {
    const r = body("x = 'ab'; x = ;");
    assert.deepEqual(r.diagnostics.map(d => d.message), ["Illegal character literal", "expected an expression but found ';'"]);
  });
  it("reports a missing closing brace at the end of the file", () => {
    const r = parse("m () : proc\n{ x = 1;");
    assert.equal(r.diagnostics.length, 1);
    assert.match(r.diagnostics[0].message, /'}'.*end of file/);
  });
  it("recovers inside declarations and keeps the body", () => {
    const r = parse("m () proc\n x int;\n y : byte;\n{ y = 1; }");
    assert.equal(r.diagnostics.length, 2);
    assert.equal(r.program!.body.stmts.length, 1);
    assert.deepEqual(r.program!.locals.map(l => l.name), ["y"]);
  });
  it("reports a broken parenthesised condition where it breaks", () => {
    const r = body("while ((x == ) ) ;");
    assert.deepEqual(r.diagnostics.map(d => [d.range.start.character, d.message]), [[15, "expected an expression but found ')'"]]);
  });
  it("ends on every prefix of an example without throwing", () => {
    const src = fs.readFileSync(path.join(ex, "BubbleSort.alan"), "utf8");
    for (let i = 0; i <= src.length; i++) {
      const starts = parse(src.slice(0, i)).diagnostics.map(d => `${d.range.start.line}:${d.range.start.character}`);
      assert.equal(new Set(starts).size, starts.length, `prefix ${i}`);
    }
  });

  const tooDeep = (src: string) =>
    parse(src).diagnostics.filter(d => d.message === "Nesting is too deep").length;
  const n = 10000;
  it("stops at deeply nested parentheses in a condition", () => {
    assert.equal(tooDeep(`m () : proc\n x : int;\n{ if (${"(".repeat(n)}x == 1${")".repeat(n)}) ; }`), 1);
  });
  it("stops at deeply nested parentheses in an expression", () => {
    const r = body(`x = ${"(".repeat(n)}1${")".repeat(n)}; x = 2;`);
    assert.deepEqual(r.diagnostics.map(d => d.message), ["Nesting is too deep"]);
    assert.equal(r.program!.body.stmts.length, 1);
  });
  it("stops at deeply nested blocks", () => {
    const r = body(`${"{".repeat(n)}${"}".repeat(n)}`);
    assert.deepEqual(r.diagnostics.map(d => d.message), ["Nesting is too deep"]);
  });
  it("stops at other deep chains without throwing", () => {
    assert.equal(tooDeep(`m () : proc\n{ ${"if (true) ".repeat(n)}; }`), 1);
    assert.equal(tooDeep(`m () : proc\n{ if (${"!".repeat(n)}true) ; }`), 1);
    assert.equal(tooDeep(`m () : proc\n x : int;\n{ x = ${"- ".repeat(n)}1; }`), 1);
  });
  it("stops at deeply nested function definitions", () => {
    const r = parse(`${"f () : proc\n".repeat(n)}${"{ }\n".repeat(n)}`);
    assert.deepEqual(r.diagnostics.map(d => [d.range.start, d.message]), [
      [{ line: 501, character: 0 }, "Nesting is too deep"],
      [{ line: 10501, character: 0 }, "expected end of file but found '{'"],
    ]);
  });
  it("stops at deeply nested call arguments and keeps the next statement", () => {
    const r = body(`${"f(".repeat(n)}1${")".repeat(n)}; g();`);
    assert.deepEqual(r.diagnostics.map(d => d.message), ["Nesting is too deep"]);
    assert.deepEqual(r.program!.body.stmts.map(s => s.kind), ["call"]);
  });
  it("stops at deeply nested array indexes and keeps the next statement", () => {
    const r = body(`x = ${"a[".repeat(n)}0${"]".repeat(n)}; g();`);
    assert.deepEqual(r.diagnostics.map(d => d.message), ["Nesting is too deep"]);
    assert.deepEqual(r.program!.body.stmts.map(s => s.kind), ["call"]);
  });
  it("keeps the token after a skipped group in a statement body", () => {
    const r = body(`if (true) ${"{".repeat(n)}${"}".repeat(n)} x = 1;`);
    assert.deepEqual(r.diagnostics.map(d => d.message), ["Nesting is too deep"]);
    assert.deepEqual(r.program!.body.stmts.map(s => s.kind), ["if", "assign"]);
  });
  it("does not swallow the closing brace after a missing if body", () => {
    const r = parse("m () : proc\n{\n  if (x > 0)\n}\n");
    assert.equal(r.diagnostics.length, 1);
    assert.deepEqual(r.diagnostics[0].range.start, { line: 3, character: 0 });
    assert.match(r.diagnostics[0].message, /statement/);
  });
  it("keeps the main body apart from a nested function ending in a broken while", () => {
    const r = parse("m () : proc\n f () : proc\n {\n   while (true)\n }\n{\n  f();\n}\n");
    assert.equal(r.diagnostics.length, 1);
    assert.equal(r.program!.body.stmts.length, 1);
    assert.equal((r.program!.locals[0] as any).body.stmts.length, 1);
  });
});
