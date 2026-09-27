// The nesting limits of check_nesting in ast.cpp, at 3000 and 3001 levels.
import { strict as assert } from "assert";
import { computeDiagnostics, firstError } from "../../src/server/diagnostics";
import { KINDS, UNCOUNTED } from "../differential/nesting-probes";

/**
 * The line of the error for each program of KINDS past the limit, as alanc
 * reports it: the smallest line of a node in the construct at level 3001,
 * which is where its first part ends, such as the true after a chain of !.
 * The blocks lines follow the line of their "{".
 */
const LINES: Record<string, number> = {
  ifs: 3007, whiles: 3007, else_ifs: 3007, blocks: 3007, if_blocks: 1507, nots: 3009, not_compare: 3008,
  right_plus: 3008, right_and: 3008, unary_minus: 3009, calls: 3009, call_statement: 3008, indexes: 3009,
  functions: 3002,
};

describe("nesting", () => {
  for (const [kind, make] of Object.entries(KINDS)) {
    it(`accepts 3000 levels of ${kind} and reports 3001`, () => {
      assert.deepEqual(computeDiagnostics(make(3000)), []);
      const text = make(kind === "if_blocks" ? 3002 : 3001);
      const first = firstError(text)!;
      assert.equal(first.message, "Nesting is too deep");
      assert.equal(first.range.start.line + 1, LINES[kind]);
      assert.deepEqual(computeDiagnostics(text).filter((d) => d.message === "Nesting is too deep").length, 1);
    });
  }
  for (const [kind, text] of Object.entries(UNCOUNTED)) {
    it(`does not count ${kind}`, () => {
      assert.deepEqual(computeDiagnostics(text), []);
    });
  }
  it("comes before the other semantic errors, as the compiler checks it first", () => {
    const text = KINDS.ifs(3001).replace("{\n", "{\n  y = 1;\n");
    assert.equal(firstError(text)!.message, "Nesting is too deep");
  });
});
