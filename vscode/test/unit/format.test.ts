import { strict as assert } from "assert";
import * as fs from "fs"; import * as path from "path";
import { formatDocument, formatRange } from "../../src/server/format";
import { lex } from "../../src/server/lexer";
import { parse } from "../../src/server/parser";

const opts = { tabSize: 4, insertSpaces: true };
const ex = path.resolve(__dirname, "../../../Examples");
const commentsCase = path.resolve(__dirname, "../../../tests/comments/comments.alan");

/** The syntax tree without positions, to compare the meaning of two texts. */
function shape(src: string): unknown {
  const r = parse(src);
  assert.equal(r.diagnostics.length, 0);
  return JSON.parse(JSON.stringify(r.program, (k, v) => (k === "range" || k === "nameRange" ? undefined : v)));
}

const fmt = (lines: string[]) => formatDocument(lines.join("\n"), opts);

describe("formatter", () => {
  it("formats a messy program", () => {
    const src = "main():proc\nx:int;\n{x=1+2*3;if(x>3)writeInteger(x);else{x=0;}}\n";
    assert.equal(formatDocument(src, opts), [
      "main () : proc",
      "    x : int;",
      "{",
      "    x = 1 + 2 * 3;",
      "    if (x > 3)",
      "        writeInteger(x);",
      "    else {",
      "        x = 0;",
      "    }",
      "}", ""].join("\n"));
  });
  it("refuses to format code with syntax errors", () => {
    assert.equal(formatDocument("main () : proc\n{ x = ; }", opts), undefined);
  });
  for (const f of fs.readdirSync(ex).filter(f => f.endsWith(".alan"))) {
    it(`is stable and keeps comments for ${f}`, () => {
      const src = fs.readFileSync(path.join(ex, f), "utf8");
      const once = formatDocument(src, opts)!;
      assert.equal(formatDocument(once, opts), once);
      const before = lex(src, { keepComments: true }).comments!.map(c => c.text.trim());
      const after = lex(once, { keepComments: true }).comments!.map(c => c.text.trim());
      assert.deepEqual(after, before);
    });
  }

  for (const file of [...fs.readdirSync(ex).filter(f => f.endsWith(".alan")).map(f => path.join(ex, f)), commentsCase]) {
    it(`keeps the meaning of ${path.basename(file)}`, () => {
      const src = fs.readFileSync(file, "utf8");
      const once = formatDocument(src, opts)!;
      assert.deepEqual(shape(once), shape(src));
      const tokens = (s: string) => lex(s).tokens.map(t => `${t.kind} ${t.text}`);
      assert.deepEqual(tokens(once), tokens(src));
    });
  }

  it("is stable and keeps the comments of the comment test case", () => {
    const src = fs.readFileSync(commentsCase, "utf8");
    const once = formatDocument(src, opts)!;
    assert.equal(formatDocument(once, opts), once);
    const texts = (s: string) => lex(s, { keepComments: true }).comments!.map(c => c.text.trim());
    assert.deepEqual(texts(once), texts(src));
  });

  it("puts else on the line after a closing brace and keeps else if on one line", () => {
    assert.equal(fmt([
      "main () : proc x : int; {",
      "if (x == 1) { x = 2; } else if (x == 2) x = 3; else while (x < 9) x = x + 1;",
      "}",
    ]), [
      "main () : proc",
      "    x : int;",
      "{",
      "    if (x == 1) {",
      "        x = 2;",
      "    }",
      "    else if (x == 2)",
      "        x = 3;",
      "    else",
      "        while (x < 9)",
      "            x = x + 1;",
      "}", ""].join("\n"));
  });

  it("indents nested functions and spaces declarations", () => {
    assert.equal(fmt([
      "main():proc",
      "f(a:reference int[],b:byte):int",
      "n:int[5];",
      "{return a[0]+b;}",
      "{f(n,'a');}",
    ]), [
      "main () : proc",
      "    f (a : reference int [], b : byte) : int",
      "        n : int [5];",
      "    {",
      "        return a[0] + b;",
      "    }",
      "{",
      "    f(n, 'a');",
      "}", ""].join("\n"));
  });

  it("spaces unary and binary operators and keeps parentheses", () => {
    assert.equal(fmt([
      "main():proc x:int; {",
      "x=-(x+1)*-x- -1;",
      "x=- -x;",
      "if(!(x<1)&x!=2|true)return;",
      "}",
    ]), [
      "main () : proc",
      "    x : int;",
      "{",
      "    x = -(x + 1) * -x - -1;",
      "    x = - -x;",
      "    if (!(x < 1) & x != 2 | true)",
      "        return;",
      "}", ""].join("\n"));
  });

  it("collapses blank lines and drops them after { and before }", () => {
    assert.equal(fmt([
      "main () : proc", "", "", "x : int;", "{", "", "x = 1;", "", "", "x = 2;", "", "}", "", "",
    ]), ["main () : proc", "", "    x : int;", "{", "    x = 1;", "", "    x = 2;", "}", ""].join("\n"));
  });

  it("keeps comments in odd places", () => {
    const src = [
      "(* head *) main -- after name",
      "() : proc",
      "  x (* in decl *) : int;",
      "{ -- open",
      "  x = 1 + -- mid",
      "  2;",
      "      -- own line",
      "  x = (* before *) 3;",
      "  -- last in block",
      "} (* after *)",
      "-- end of file",
    ].join("\n");
    const once = formatDocument(src, opts)!;
    assert.equal(once, [
      "(* head *) main -- after name",
      "    () : proc",
      "    x (* in decl *) : int;",
      "{ -- open",
      "    x = 1 + -- mid",
      "        2;",
      "    -- own line",
      "    x = (* before *) 3;",
      "    -- last in block",
      "} (* after *)",
      "-- end of file", ""].join("\n"));
    assert.equal(formatDocument(once, opts), once);
  });

  it("keeps a body brace at its statement's depth when a comment pushes it down", () => {
    const src = [
      "main () : proc x : int; {",
      "if (x == 1) -- after if",
      "{ x = 2; }",
      "else -- after else",
      "{ x = 0; }",
      "while (x < 3) -- after while",
      "{ x = x + 1; }",
      "if (x == 1) x = 1; else -- before else if",
      "if (x == 2) x = 2;",
      "}",
    ].join("\n");
    const once = formatDocument(src, opts)!;
    assert.equal(once, [
      "main () : proc",
      "    x : int;",
      "{",
      "    if (x == 1) -- after if",
      "    {",
      "        x = 2;",
      "    }",
      "    else -- after else",
      "    {",
      "        x = 0;",
      "    }",
      "    while (x < 3) -- after while",
      "    {",
      "        x = x + 1;",
      "    }",
      "    if (x == 1)",
      "        x = 1;",
      "    else -- before else if",
      "    if (x == 2)",
      "        x = 2;",
      "}", ""].join("\n"));
    assert.equal(formatDocument(once, opts), once);
  });

  it("keeps a closing brace on its own line after a block comment", () => {
    const once = formatDocument("main () : proc\n{\n  x = 1;\n(* c *) }\n", opts)!;
    assert.equal(once, "main () : proc\n{\n    x = 1;\n    (* c *)\n}\n");
    assert.equal(formatDocument(once, opts), once);
  });

  it("gives a comment before a function body the header's indent", () => {
    const src = "main () : proc\n f () : proc\n  x : int;\n-- f body\n { x = 1; }\n  -- main body\n{ f(); }\n";
    assert.equal(formatDocument(src, opts), [
      "main () : proc",
      "    f () : proc",
      "        x : int;",
      "    -- f body",
      "    {",
      "        x = 1;",
      "    }",
      "-- main body",
      "{",
      "    f();",
      "}", ""].join("\n"));
  });

  it("formats a 5,000 line file full of comments quickly", () => {
    const lines = ["main () : proc", "x : int;", "{"];
    for (let i = 0; i < 2500; i++) lines.push(`-- step ${i}`, `x = x + ${i}; (* ${i} *)`);
    lines.push("}");
    const src = lines.join("\n");
    formatDocument(src, opts);   // warm up
    const t0 = process.hrtime.bigint();
    const out = formatDocument(src, opts);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(out);
    assert.ok(ms < 100, `took ${ms.toFixed(1)} ms`);
  });

  it("copies block comments over lines and re-indents the first line", () => {
    const src = "main () : proc\n{\n        (* a\n   b *)\n  x = 1;\n}\n";
    assert.equal(formatDocument(src, opts), "main () : proc\n{\n    (* a\n   b *)\n    x = 1;\n}\n");
  });

  it("keeps the input's line ending and indents with tabs when asked", () => {
    const src = "main () : proc\r\nx : int;\r\n{ x = 1; }";
    assert.equal(formatDocument(src, { tabSize: 4, insertSpaces: false }),
      "main () : proc\r\n\tx : int;\r\n{\r\n\tx = 1;\r\n}\r\n");
  });

  it("keeps comments when asked to and not otherwise", () => {
    const r = lex("(* a (* b *) c *) x -- y\r\nz", { keepComments: true });
    assert.deepEqual(r.comments, [
      { text: "(* a (* b *) c *)", block: true, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 17 } } },
      { text: "-- y", block: false, range: { start: { line: 0, character: 20 }, end: { line: 0, character: 24 } } },
    ]);
    assert.equal("comments" in lex("x -- y"), false);
  });

  it("formats whole lines of a range", () => {
    const src = "main () : proc\n{\n  x=1;\n    y  =2;\n  z=3;\n}\n";
    const r = formatRange(src, { start: { line: 3, character: 2 }, end: { line: 3, character: 3 } }, opts)!;
    assert.deepEqual(r, {
      range: { start: { line: 3, character: 0 }, end: { line: 3, character: 10 } },
      newText: "    y = 2;",
    });
  });

  it("widens a range to whole statements", () => {
    const src = "main () : proc\n{\n  x=1+\n2;\n}\n";
    const r = formatRange(src, { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } }, opts)!;
    assert.deepEqual(r, {
      range: { start: { line: 2, character: 0 }, end: { line: 3, character: 2 } },
      newText: "    x = 1 + 2;",
    });
  });

  it("refuses to format a range of code with syntax errors", () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } };
    assert.equal(formatRange("main () : proc\n{ x = ; }", range, opts), undefined);
  });
});
