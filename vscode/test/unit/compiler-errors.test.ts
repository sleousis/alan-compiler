// The compiler's own error tests, run through the language server's
// diagnostics: each file in tests/errors must get the error that
// tests/errors/expected.json gives, as the first error and on the same
// line, and each program in tests/regress must get none.
import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { computeDiagnostics, firstError } from "../../src/server/diagnostics";

const repo = path.resolve(__dirname, "../../..");
const read = (file: string) => fs.readFileSync(path.join(repo, file), "utf8");

interface Expected { file: string; line: number | null; contains: string; }
const expected: Expected[] = JSON.parse(read("tests/errors/expected.json"));

/**
 * Where the server puts a syntax error on another line than bison. The
 * server reports a missing ";" at the end of the token before it, bison at
 * the token after it.
 */
const SYNTAX_LINES: Record<string, { line: number; message: RegExp }> = {
  "tests/errors/missing_semicolon.alan": { line: 4, message: /^expected ';' but found 'writeInteger'$/ },
};

describe("compiler error tests", () => {
  it("lists every file of tests/errors in expected.json", () => {
    const files = fs.readdirSync(path.join(repo, "tests/errors")).filter((f) => f.endsWith(".alan")).map((f) => `tests/errors/${f}`);
    assert.deepEqual(files.filter((f) => !expected.some((e) => e.file === f)), []);
  });

  for (const e of expected) {
    it(`reports the error of ${e.file}`, () => {
      const first = firstError(read(e.file));
      assert.ok(first, "no error");
      const syntax = SYNTAX_LINES[e.file];
      if (syntax) {
        assert.equal(first.range.start.line + 1, syntax.line);
        assert.match(first.message, syntax.message);
        return;
      }
      // "error:" only says that the compiler fails, and any message will do.
      if (e.contains !== "error:") assert.ok(first.message.includes(e.contains), `${first.message} lacks ${e.contains}`);
      if (e.line !== null) assert.equal(first.range.start.line + 1, e.line, first.message);
      // The first error is also a live diagnostic.
      assert.ok(computeDiagnostics(read(e.file)).some((d) => d.message === first.message && d.range.start.line === first.range.start.line));
    });
  }

  for (const f of fs.readdirSync(path.join(repo, "tests/regress")).filter((n) => n.endsWith(".alan"))) {
    it(`finds no error in tests/regress/${f}`, () => {
      assert.deepEqual(computeDiagnostics(read(`tests/regress/${f}`)), []);
    });
  }
});
