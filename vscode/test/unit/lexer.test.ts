import { strict as assert } from "assert";
import { readdirSync, readFileSync } from "fs";
import * as path from "path";
import { lex } from "../../src/server/lexer";

const kinds = (src: string) => lex(src).tokens.map((t) => t.kind);

describe("lexer", () => {
  it("lexes keywords, ids, numbers and operators", () => {
    const k = lex("main () : proc x == 10 != y").tokens.map(t => t.kind);
    assert.deepEqual(k, ["id","(",")",":","kw_proc","id","==","int","!=","id","eof"]);
  });
  it("skips nested comments and line comments", () => {
    const r = lex("(* a (* b *) c *) x -- y\nz");
    assert.deepEqual(r.tokens.map(t => t.text), ["x","z",""]);
    assert.equal(r.errors.length, 0);
  });
  it("tracks positions with CRLF", () => {
    const t = lex("a\r\n  b").tokens[1];
    assert.deepEqual(t.range.start, { line: 1, character: 2 });
  });
  it("reads char and string literals with escapes", () => {
    const k = lex(`'\\n' '\\x4f' '\\x4F' "a\\"b\\xAb"`).tokens.map(t => t.kind);
    assert.deepEqual(k, ["char","char","char","string","eof"]);
  });
  it("reports unterminated comment and illegal phrase", () => {
    assert.match(lex("(* open").errors[0].message, /comment/);
    assert.equal(lex("12abc").errors[0].message, "Illegal phrase!");
  });

  it("maps every keyword and leaves longer words as ids", () => {
    assert.deepEqual(kinds("if else while return int byte reference proc true false iff"), [
      "kw_if", "kw_else", "kw_while", "kw_return", "kw_int", "kw_byte",
      "kw_reference", "kw_proc", "kw_true", "kw_false", "id", "eof",
    ]);
  });

  it("reads every operator and punctuation mark", () => {
    assert.deepEqual(kinds("== != <= >= = ! | & < > ( ) [ ] { } , : + - * % / ;"), [
      "==", "!=", "<=", ">=", "=", "!", "|", "&", "<", ">", "(", ")",
      "[", "]", "{", "}", ",", ":", "+", "-", "*", "%", "/", ";", "eof",
    ]);
  });

  it("lets comments hold any text, as lexer.l does", () => {
    for (const src of ["(***)", "(*)*)", "(* \" ' ) * -- *)", "(* a\n(* b\n*)\n*)"]) {
      const r = lex(src + " x");
      assert.deepEqual(r.tokens.map((t) => t.text), ["x", ""], src);
      assert.equal(r.errors.length, 0, src);
    }
  });

  it("reports an unterminated comment at the line of the outermost opener", () => {
    const r = lex("x\n  (* a\n(* b *)\nc");
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].message, "Unterminated comment");
    assert.deepEqual(r.errors[0].range.start, { line: 1, character: 2 });
    assert.deepEqual(kinds("x\n  (* a\n(* b *)\nc"), ["id", "eof"]);
  });

  it("accepts every char literal form from lexer.l", () => {
    const good = ["'a'", "'Z'", "'7'", "' '", "'!'", "';'", "'('", "'_'", "'.'", "'~'", "'#'", "'\\n'", "'\\t'",
      "'\\r'", "'\\0'", "'\\\\'", "'\\''", "'\\\"'", "'\\x0a'", "'\\xff'", "'\\xFF'", "'\\xaB'"];
    for (const src of good) {
      const r = lex(src);
      assert.deepEqual(r.tokens.map((t) => t.kind), ["char", "eof"], src);
      assert.equal(r.tokens[0].text, src);
      assert.equal(r.errors.length, 0, src);
    }
  });

  it("rejects char literals lexer.l does not accept", () => {
    for (const src of ["'ab'", "'\\xG0'", "'\\q'", "'\"'", "'\\'", "'''", "''", "'\t'", "'\u00e9'", "'\\x4'"]) {
      const r = lex(src);
      assert.equal(r.tokens[0].kind, "bad", src);
      assert.equal(r.errors[0].message, "Invalid character constant", src);
    }
  });

  it("reports an unterminated char or string at its start", () => {
    const c = lex("x 'a");
    assert.equal(c.tokens[1].kind, "bad");
    assert.deepEqual(c.errors[0].range.start, { line: 0, character: 2 });
    assert.equal(c.errors[0].message, "Invalid character constant");

    const s = lex("x \"abc\ny");
    assert.deepEqual(s.tokens.map((t) => t.kind), ["id", "bad", "id", "eof"]);
    assert.equal(s.errors.length, 1);
    assert.equal(s.errors[0].message, "String literal not closed on this line");
    assert.deepEqual(s.errors[0].range.start, { line: 0, character: 2 });
  });

  it("reports broken strings with the messages of lexer.l", () => {
    const first = (src: string) => {
      const e = lex(src).errors[0];
      return e && [e.message, e.range.start.character, e.range.end.character];
    };
    assert.deepEqual(first('x "a\\qb" y'), ["Invalid escape sequence \\q in string literal", 4, 6]);
    assert.deepEqual(first('x "a\\x4g"'), ["Invalid escape sequence \\x in string literal", 4, 6]);
    // A backslash at the end of a line or of the file leaves the string open.
    assert.deepEqual(first('x "ab\\'), ["String literal not closed on this line", 2, 6]);
    assert.deepEqual(first('x "ab\\\ny'), ["String literal not closed on this line", 2, 6]);
    assert.deepEqual(first('x "ab\\\r\ny'), ["String literal not closed on this line", 2, 6]);
    assert.deepEqual(first('x "ab\\\u0000"'), ["Invalid escape sequence \\ in string literal", 5, 7]);
    assert.deepEqual(first('x "a\u0000b"'), ["NUL character in string literal", 4, 5]);
    assert.deepEqual(first('x "abc\ny'), ["String literal not closed on this line", 2, 6]);
    // lexer.l prefers "not closed" when an escaped quote ends the line.
    assert.deepEqual(first('x "a\\"\ny'), ["String literal not closed on this line", 2, 6]);
    for (const good of ['"a\\x4F\\xaB"', '"\\n\\t\\r\\0\\\\\\\'\\""', '"tab\there, \u00e9 and \\x41"']) {
      const r = lex(good);
      assert.deepEqual(r.tokens.map((t) => t.kind), ["string", "eof"], good);
      assert.deepEqual(r.errors, [], good);
    }
  });

  it("goes on after a broken string at its closing quote", () => {
    const r = lex('"a\\qb" x');
    assert.deepEqual(r.tokens.map((t) => [t.kind, t.text]), [["bad", '"a\\qb"'], ["id", "x"], ["eof", ""]]);
  });

  it("reports int constants above 2147483647 and keeps them as ints", () => {
    const r = lex("2147483647 2147483648 99999999999999999999");
    assert.deepEqual(r.tokens.map((t) => t.kind), ["int", "int", "int", "eof"]);
    assert.deepEqual(r.errors.map((e) => [e.message, e.range.start.character]), [
      ["Integer constant 2147483648 is out of range (0 to 2147483647)", 11],
      ["Integer constant 99999999999999999999 is out of range (0 to 2147483647)", 22],
    ]);
    assert.deepEqual(lex("0002147483647").errors, []);
  });

  it("keeps string text including quotes and escapes", () => {
    const t = lex(`"a\\\\" "b"`).tokens;
    assert.deepEqual(t.map((x) => x.text), [`"a\\\\"`, `"b"`, ""]);
  });

  it("turns a digit run followed by a letter into one bad token", () => {
    const r = lex("12abc_3 x");
    assert.deepEqual(r.tokens.map((t) => [t.kind, t.text]), [["bad", "12abc_3"], ["id", "x"], ["eof", ""]]);
    assert.equal(r.errors[0].message, "Illegal phrase!");
  });

  it("reports any other character as illegal", () => {
    const r = lex("a @ _b");
    assert.deepEqual(r.tokens.map((t) => [t.kind, t.text]), [["id", "a"], ["bad", "@"], ["bad", "_"], ["id", "b"], ["eof", ""]]);
    assert.equal(r.errors.length, 2);
    assert.equal(r.errors[0].message, "Illegal character or phrase!");
    assert.deepEqual(r.errors[0].range, { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } });
  });

  it("gives the same tokens and errors for CRLF as for LF at line ends", () => {
    for (const lf of ['x "abc\ny', "x 'a\ny", "x '\\q\ny", 'x "ab\\\ny', "x 'ab\\\ny", "x -- note\ny"]) {
      assert.deepEqual(lex(lf.replace(/\n/g, "\r\n")), lex(lf), JSON.stringify(lf));
    }
    const r = lex('x "abc\r\ny');
    assert.equal(r.tokens[1].text, '"abc');
    assert.deepEqual(r.errors[0].range.end, { line: 0, character: 6 });
  });

  it("lexes every repo .alan file the same as LF and as CRLF", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".alan")) files.push(p);
      }
    };
    walk(path.join(__dirname, "..", "..", ".."));
    assert.ok(files.length > 0);
    for (const f of files) {
      const lf = readFileSync(f, "utf8").replace(/\r\n/g, "\n");
      assert.deepEqual(lex(lf.replace(/\n/g, "\r\n")), lex(lf), f);
    }
  });

  it("gives token ranges and an eof token at the end", () => {
    const t = lex("ab\n  cd").tokens;
    assert.deepEqual(t[1].range, { start: { line: 1, character: 2 }, end: { line: 1, character: 4 } });
    assert.deepEqual(t[2].range, { start: { line: 1, character: 4 }, end: { line: 1, character: 4 } });
  });
});
