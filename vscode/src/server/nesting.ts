// The nesting limits of the compiler, from check_nesting in ast.cpp. It runs
// before the other checks and counts three kinds of nesting, each up to
// 3000 levels:
// - statements: while, if and if-else (the if of an if-else is one level),
//   and blocks used as statements (not a function's body),
// - expressions: operators, !, comparisons, & and |, calls and array
//   elements, where the left operand of a chain such as a + b - c or
//   p & q | r is not a level deeper,
// - functions: function definitions inside functions.
// Parentheses do not count. The first construct past a limit, in
// the compiler's walk order, is reported on the first line of its tree.
//
// The compiler's tree differs from the one of parser.ts in small ways that
// do not matter here: a statement list is a chain of SEQ nodes, -x is 0 - x,
// and an if-else is an IFELSE node over an IF node.
import { Cond, Diagnostic, Expr, FuncDecl, Param, Stmt, VarDecl } from "./ast";
import { Range } from "./lexer";
import { MSG } from "./messages";

const MAX_NESTING = 3000;

type Node = FuncDecl | VarDecl | Stmt | Expr | Cond | { kind: "param"; param: Param };

/** A child and whether it is the compiler's left child, which the chain rule needs. */
type Child = { node: Node; left: boolean };

const isStatement = (n: Node) => n.kind === "if" || n.kind === "while" || n.kind === "block";
const isArithmetic = (n: Node) => n.kind === "binary" || n.kind === "unary";
const isLogical = (n: Node) => n.kind === "logic";
const isExpression = (n: Node) => isArithmetic(n) || isLogical(n) || n.kind === "not" || n.kind === "compare"
  || n.kind === "index" || (n.kind === "call" && !("call" in n));

/** A call statement is the call itself in the compiler's tree. */
const unwrap = (n: Node): Node => (n.kind === "call" && "call" in n ? n.call : n);

function children(n: Node): Child[] {
  const all = (nodes: Node[]): Child[] => nodes.map((node) => ({ node: unwrap(node), left: false }));
  switch (n.kind) {
    case "func":
      return all([...n.params.map((param) => ({ kind: "param" as const, param })), ...n.locals, n.body]);
    case "block":
      return all(n.stmts);
    case "assign":
      return all([n.target, n.value]);
    case "if":
      return all(n.else ? [n.cond, n.then, n.else] : [n.cond, n.then]);
    case "while":
      return all([n.cond, n.body]);
    case "return":
      return all(n.value ? [n.value] : []);
    case "index":
      return all([n.index]);
    case "call":
      return "call" in n ? children(n.call) : all(n.args);
    case "unary":
      return all([n.operand]);
    case "binary":
    case "logic":
      return [{ node: n.left, left: true }, { node: n.right, left: false }];
    case "compare":
      return all([n.left, n.right]);
    case "not":
      return all([n.operand]);
    default:
      return [];
  }
}

/** The tokens that give the lines of the compiler's own nodes for n, not counting its children. */
function ownLines(n: Node): Range[] {
  switch (n.kind) {
    case "block":
      // The line of its "{".
      return [{ start: n.range.start, end: { line: n.range.start.line, character: n.range.start.character + 1 } }];
    case "func":
    case "var":
    case "assign":
    case "return":
    case "name":
    case "index":
    case "unary":
    case "binary":
    case "compare":
      return [n.at];
    case "param":
      return [n.param.at];
    case "call":
      return "call" in n ? [] : [n.at];
    case "int":
    case "char":
    case "string":
    case "bool":
      return [n.range];
    default:
      return [];
  }
}

/** Like firstLine: the token with the smallest line in the tree of n. */
function firstLine(n: Node): Range {
  let best: Range | undefined;
  const todo: Node[] = [n];
  while (todo.length) {
    const t = todo.pop()!;
    for (const r of ownLines(t)) if (!best || r.start.line < best.start.line) best = r;
    for (const c of children(t)) todo.push(c.node);
  }
  // Every construct the limits count holds a node with a line.
  return best ?? (n as { range: Range }).range;
}

/** The "Nesting is too deep" error of the program, if it has one. */
export function checkNesting(program: FuncDecl): Diagnostic[] {
  interface Item { node: Node; stmt: number; expr: number; func: number; }
  const todo: Item[] = [{ node: program, stmt: 0, expr: 0, func: 0 }];
  while (todo.length) {
    const it = todo.pop()!;
    if (it.stmt > MAX_NESTING || it.expr > MAX_NESTING || it.func > MAX_NESTING) {
      return [{ message: MSG.nestingTooDeep, range: firstLine(it.node), severity: "error", source: "alan", code: "nesting" }];
    }
    const kids = children(it.node);
    // The last child goes first, so the first one is visited first.
    for (let i = kids.length - 1; i >= 0; i--) {
      const c = kids[i].node;
      const next: Item = { node: c, stmt: it.stmt, expr: it.expr, func: it.func };
      // A function's body is no statement of its own.
      const body = it.node.kind === "func" && c === it.node.body;
      if (isStatement(c) && !body) next.stmt++;
      if (c.kind === "func") next.func++;
      const chain = kids[i].left && ((isArithmetic(it.node) && isArithmetic(c)) || (isLogical(it.node) && isLogical(c)));
      if (isExpression(c) && !chain) next.expr++;
      todo.push(next);
    }
  }
  return [];
}
