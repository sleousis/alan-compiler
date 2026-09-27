// Recursive descent parser for Alan. It follows the grammar of parser.y at the
// repository root and keeps going after errors, so the editor can show every
// problem in a file at once and still build a tree for the rest of it.
//
// The compiler takes nesting of any depth here, and limits some kinds of it
// later (see nesting.ts). So the recursive rules are generators run by
// trampoline.ts, and nesting costs memory instead of stack.
import {
  Block, Call, Cond, DataType, Diagnostic, Expr, FuncDecl, LValue, Param, Stmt, TypeRef, VarDecl,
} from "./ast";
import { Pos, Range, Token, TokenKind, lex } from "./lexer";
import { Task, run } from "./trampoline";

/** Thrown after an error is reported. The nearest statement or declaration catches it and resyncs. */
class ParseError {}

type RelOp = Extract<Cond, { kind: "compare" }>["op"];
/** A parse of an expression at some token, see expr. A failed one has no node. */
type ExprOutcome = { node?: Expr; end: number; held: boolean; diagnostics: Diagnostic[]; errors: number };
/** What a failed try of "(" cond ")" reported, see parenCond. */
type ParenFailure = { failedAt: number; diagnostics: Diagnostic[]; errors: number };

const REL_OPS = new Set<TokenKind>(["==", "!=", "<", ">", "<=", ">="]);
const ARITH_OPS = new Set<TokenKind>(["+", "-", "*", "/", "%"]);
/** Tokens that begin a statement no matter where they stand. */
const STMT_KEYWORDS = new Set<TokenKind>(["kw_if", "kw_while", "kw_return", "{"]);

const posKey = (p: Pos) => `${p.line}:${p.character}`;
const comparePos = (a: Pos, b: Pos) => a.line - b.line || a.character - b.character;

class Parser {
  private pos = 0;
  /** Errors met so far, reported or not. A speculative parse failed when this grew. */
  private errorCount = 0;
  /** Start positions that already carry a diagnostic. */
  private readonly reported: Set<string>;
  /**
   * Expressions after which bison holds a lookahead token, see ast.ts. A
   * name needs one to tell it from an indexed name or a call, and + and -
   * need one to see whether a *, / or % binds first. The other rules end on
   * a token of their own or pass on what their last part left.
   */
  private readonly lookahead = new WeakSet<Expr>();
  /**
   * The outcome of parsing an expression at each token index. A condition
   * in parentheses is tried as a condition first and then as an expression,
   * and without this each level of parentheses would parse everything
   * inside it again, which takes quadratic time.
   */
  private readonly exprs = new Map<number, ExprOutcome>();

  constructor(private readonly tokens: Token[], readonly diagnostics: Diagnostic[]) {
    this.reported = new Set(diagnostics.map((d) => posKey(d.range.start)));
  }

  // ---- helpers ------------------------------------------------------------

  private peek(k = 0): Token {
    return this.tokens[Math.min(this.pos + k, this.tokens.length - 1)];
  }

  private at(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private next(): Token {
    const t = this.peek();
    if (t.kind !== "eof") this.pos++;
    return t;
  }

  private eat(kind: TokenKind): Token | undefined {
    return this.at(kind) ? this.next() : undefined;
  }

  /** The last consumed token, or the first token when nothing is consumed yet. */
  private prev(): Token {
    return this.tokens[Math.max(this.pos - 1, 0)];
  }

  /** The token whose line the compiler gives a node that ends here, with or without a lookahead. */
  private lineToken(lookahead: boolean): Range {
    return (lookahead ? this.peek() : this.prev()).range;
  }

  /** Range from the start of `first` to the end of the last consumed token. */
  private span(first: Token): Range {
    return { start: first.range.start, end: this.prev().range.end };
  }

  /** True when the token at index i is the first token on its line. */
  private startsLine(i: number): boolean {
    return i === 0 || this.tokens[i - 1].range.end.line < this.tokens[i].range.start.line;
  }

  private describe(t: Token): string {
    return t.kind === "eof" ? "end of file" : `'${t.text}'`;
  }

  /**
   * Records an error unless it sits on a token with a lexer error (the lexer
   * already said why, and the compiler stops there) or another error
   * already starts at the same position.
   */
  private report(message: string, range: Range, token?: Token) {
    this.errorCount++;
    if (token?.kind === "bad" || token?.flawed) return;
    this.add({ message, range, severity: "error", source: "alan" });
  }

  /** Adds a diagnostic unless one already starts at the same position. */
  private add(d: Diagnostic) {
    const key = posKey(d.range.start);
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.diagnostics.push(d);
  }

  /** Drops the diagnostics added after the first n, for a rewind. */
  private truncateDiagnostics(n: number) {
    for (const d of this.diagnostics.splice(n)) this.reported.delete(posKey(d.range.start));
  }

  /** Last resort for a bug in the parser: report it at the current token instead of throwing. */
  internalError(e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    this.add({ message: `Parser failure: ${message}`, range: this.peek().range, severity: "error", source: "alan" });
  }

  /** Reports "expected X but found Y" at the current token. */
  private unexpected(what: string) {
    const t = this.peek();
    this.report(`expected ${what} but found ${this.describe(t)}`, t.range, t);
  }

  private fail(what: string): never {
    this.unexpected(what);
    throw new ParseError();
  }

  private expect(kind: TokenKind, what = `'${kind}'`): Token {
    return this.eat(kind) ?? this.fail(what);
  }

  /**
   * Expects the ";" that ends a statement or declaration. A missing one is
   * reported as an empty range at the end of the previous token. When the
   * next token clearly starts something new, parsing simply goes on.
   */
  private expectSemicolon() {
    if (this.eat(";")) return;
    const t = this.peek();
    const end = this.prev().range.end;
    this.report(`expected ';' but found ${this.describe(t)}`, { start: end, end }, t);
    const fresh = t.range.start.line > end.line || STMT_KEYWORDS.has(t.kind)
      || t.kind === "}" || t.kind === "eof";
    if (!fresh || t.kind === "bad") throw new ParseError();
  }

  /**
   * Skips to a point where a statement can start. Moves past `from` if still
   * there, unless it is the "}" that ends the enclosing block.
   */
  private syncStmt(from: number) {
    if (this.pos === from && !this.at("}")) this.next();
    for (;;) {
      const t = this.peek();
      if (t.kind === "eof" || t.kind === "}" || STMT_KEYWORDS.has(t.kind)) return;
      if (t.kind === ";") { this.next(); return; }
      if ((t.kind === "id" || t.kind === "string") && this.startsLine(this.pos)) return;
      this.next();
    }
  }

  /**
   * Skips to a point where a declaration or a function body can start. Moves
   * past `from` if still there, unless it is the "{" of the body.
   */
  private syncDecl(from: number) {
    if (this.pos === from && !this.at("{")) this.next();
    for (;;) {
      const t = this.peek();
      if (t.kind === "eof" || t.kind === "{") return;
      if (t.kind === ";") { this.next(); return; }
      if (t.kind === "id" && this.startsLine(this.pos)) return;
      this.next();
    }
  }

  // ---- declarations -------------------------------------------------------

  *program(): Task<FuncDecl | undefined> {
    let program: FuncDecl | undefined;
    if (!this.at("id")) {
      this.unexpected("a function definition");
      this.next();
      while (!this.at("eof") && !(this.at("id") && this.peek(1).kind === "(")) this.next();
    }
    if (this.at("id")) program = (yield this.funcDef()) as FuncDecl;
    if (!this.at("eof")) this.unexpected("end of file");
    return program;
  }

  /** funcDef = id "(" [param {"," param}] ")" ":" (dataType | "proc") {localDef} block */
  private *funcDef(): Task<FuncDecl> {
    const nameTok = this.next();
    const params: Param[] = [];
    let ret: DataType | "proc" = "proc";
    let at = nameTok.range;
    const headerStart = this.pos;
    try {
      this.expect("(");
      if (!this.at(")")) {
        params.push(this.param());
        while (this.eat(",")) params.push(this.param());
      }
      this.expect(")", "',' or ')'");
      this.expect(":");
      if (this.eat("kw_proc")) ret = "proc";
      else ret = this.dataType("'int', 'byte' or 'proc'");
      at = this.prev().range;
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      this.syncDecl(headerStart);
    }

    const locals: (FuncDecl | VarDecl)[] = [];
    while (!this.at("{") && !this.at("eof")) {
      const from = this.pos;
      try {
        if (this.at("id") && this.peek(1).kind === "(") locals.push((yield this.funcDef()) as FuncDecl);
        else if (this.at("id") && this.peek(1).kind === ":") locals.push(this.varDef());
        else if (this.at("id")) { this.next(); this.fail("':' or '('"); }
        else this.fail("'{'");
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.syncDecl(from);
      }
    }

    let body: Block;
    if (this.at("{")) body = (yield this.block()) as Block;
    else {
      this.unexpected("'{'");
      body = { kind: "block", stmts: [], range: this.peek().range };
    }
    return {
      kind: "func", name: nameTok.text, nameRange: nameTok.range, params, ret, locals, body,
      range: this.span(nameTok), at,
    };
  }

  /** param = id ":" ["reference"] dataType ["[" "]"] */
  private param(): Param {
    const nameTok = this.expect("id", "a parameter name");
    this.expect(":");
    const byRef = !!this.eat("kw_reference");
    const typeStart = this.peek();
    const base = this.dataType("'int' or 'byte'");
    let array = false;
    // Bison reads the token after the type to see whether "[" follows.
    let at = this.peek().range;
    if (this.eat("[")) { this.expect("]"); array = true; at = this.prev().range; }
    const type: TypeRef = { base, array, range: this.span(typeStart) };
    return { name: nameTok.text, nameRange: nameTok.range, byRef, type, at };
  }

  /** varDef = id ":" dataType ["[" int "]"] ";" */
  private varDef(): VarDecl {
    const nameTok = this.next();
    this.expect(":");
    const type = this.dataType("'int' or 'byte'");
    let size: number | undefined;
    if (this.eat("[")) {
      size = Number(this.expect("int", "an array size").text);
      this.expect("]");
    }
    this.expectSemicolon();
    const decl: VarDecl = {
      kind: "var", name: nameTok.text, nameRange: nameTok.range, type, range: this.span(nameTok), at: this.prev().range,
    };
    if (size !== undefined) decl.size = size;
    return decl;
  }

  private dataType(what: string): DataType {
    if (this.eat("kw_int")) return "int";
    if (this.eat("kw_byte")) return "byte";
    return this.fail(what);
  }

  // ---- statements ---------------------------------------------------------

  /** block = "{" {stmt} "}". A missing "}" is reported but the block is kept. */
  private *block(): Task<Block> {
    const open = this.next();
    const stmts: Stmt[] = [];
    while (!this.at("}") && !this.at("eof")) {
      const s = (yield this.stmt()) as Stmt | undefined;
      if (s) stmts.push(s);
    }
    if (!this.eat("}")) this.unexpected("'}'");
    return { kind: "block", stmts, range: this.span(open) };
  }

  /** Parses one statement, or skips a broken one and returns undefined. */
  private *stmt(): Task<Stmt | undefined> {
    const from = this.pos;
    try {
      return (yield this.stmtOrThrow()) as Stmt;
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      this.syncStmt(from);
      return undefined;
    }
  }

  /** A statement that must be there, such as the body of an if. A broken one becomes empty. */
  private *innerStmt(): Task<Stmt> {
    const first = this.peek();
    const from = this.pos;
    const s = (yield this.stmt()) as Stmt | undefined;
    if (s) return s;
    const at = first.range.start;
    return { kind: "empty", range: this.pos > from ? this.span(first) : { start: at, end: at } };
  }

  private *stmtOrThrow(): Task<Stmt> {
    const first = this.peek();
    switch (first.kind) {
      case ";":
        this.next();
        return { kind: "empty", range: first.range };
      case "{":
        return (yield this.block()) as Block;
      case "kw_if": {
        this.next();
        this.expect("(");
        const cond = (yield this.cond()) as Cond;
        this.expect(")");
        const then = (yield this.innerStmt()) as Stmt;
        if (this.eat("kw_else")) {
          const otherwise = (yield this.innerStmt()) as Stmt;
          return { kind: "if", cond, then, else: otherwise, range: this.span(first) };
        }
        return { kind: "if", cond, then, range: this.span(first) };
      }
      case "kw_while": {
        this.next();
        this.expect("(");
        const cond = (yield this.cond()) as Cond;
        this.expect(")");
        const body = (yield this.innerStmt()) as Stmt;
        return { kind: "while", cond, body, range: this.span(first) };
      }
      case "kw_return": {
        this.next();
        const value = this.atExprStart() ? (yield this.expr()) as Expr : undefined;
        this.expectSemicolon();
        const at = this.prev().range;
        return value ? { kind: "return", value, range: this.span(first), at } : { kind: "return", range: this.span(first), at };
      }
      case "id":
        if (this.peek(1).kind === "(") {
          const call = (yield this.call()) as Call;
          this.expectSemicolon();
          return { kind: "call", call, range: this.span(first) };
        }
        return (yield this.assignment()) as Stmt;
      case "string":
        return (yield this.assignment()) as Stmt;
      default:
        return this.fail("a statement");
    }
  }

  /** lvalue "=" expr ";" */
  private *assignment(): Task<Stmt> {
    const first = this.peek();
    const target = (yield this.lvalue()) as LValue;
    this.expect("=", target.kind === "name" ? "'=', '[' or '('" : "'='");
    const value = (yield this.expr()) as Expr;
    this.expectSemicolon();
    return { kind: "assign", target, value, range: this.span(first), at: this.prev().range };
  }

  /** lvalue = id ["[" expr "]"] | string */
  private *lvalue(): Task<LValue> {
    const t = this.next();
    if (t.kind === "string") return { kind: "string", value: t.text, range: t.range };
    if (this.at("[")) {
      this.next();
      const index = (yield this.expr()) as Expr;
      this.expect("]");
      return { kind: "index", name: t.text, nameRange: t.range, index, range: this.span(t), at: this.prev().range };
    }
    const name: LValue = { kind: "name", name: t.text, range: t.range, at: this.peek().range };
    this.lookahead.add(name);
    return name;
  }

  /** id "(" [expr {"," expr}] ")" */
  private *call(): Task<Call> {
    const nameTok = this.next();
    this.next();
    const args: Expr[] = [];
    if (!this.at(")")) {
      args.push((yield this.expr()) as Expr);
      while (this.eat(",")) args.push((yield this.expr()) as Expr);
    }
    this.expect(")", "',' or ')'");
    return { kind: "call", name: nameTok.text, nameRange: nameTok.range, args, range: this.span(nameTok), at: this.prev().range };
  }

  // ---- expressions --------------------------------------------------------

  private atExprStart(): boolean {
    const k = this.peek().kind;
    return k === "int" || k === "char" || k === "string" || k === "id" || k === "(" || k === "+" || k === "-";
  }

  /**
   * expr, remembered by where it starts. Parsing an expression depends only
   * on where it starts, so a second parse there replays the first one: its
   * errors, where it ended, and whether it failed.
   */
  private *expr(): Task<Expr> {
    const start = this.pos;
    const seen = this.exprs.get(start);
    if (seen) {
      for (const d of seen.diagnostics) this.add(d);
      this.errorCount += seen.errors;
      this.pos = seen.end;
      if (!seen.node) throw new ParseError();
      if (seen.held) this.lookahead.add(seen.node);
      else this.lookahead.delete(seen.node);
      return seen.node;
    }
    const before = { diagnostics: this.diagnostics.length, errors: this.errorCount };
    const remember = (node?: Expr) => this.exprs.set(start, {
      node, end: this.pos, held: !!node && this.lookahead.has(node),
      diagnostics: this.diagnostics.slice(before.diagnostics), errors: this.errorCount - before.errors,
    });
    try {
      const node = (yield this.sum()) as Expr;
      remember(node);
      return node;
    } catch (e) {
      if (e instanceof ParseError) remember();
      throw e;
    }
  }

  /** expr = term {("+"|"-") term} */
  private *sum(): Task<Expr> {
    const first = this.peek();
    let left = (yield this.term()) as Expr;
    while (this.at("+") || this.at("-")) {
      const op = this.next().kind as "+" | "-";
      const right = (yield this.term()) as Expr;
      left = { kind: "binary", op, left, right, range: this.span(first), at: this.lineToken(true) };
      this.lookahead.add(left);
    }
    return left;
  }

  /** term = unary {("*"|"/"|"%") unary} */
  private *term(): Task<Expr> {
    const first = this.peek();
    let left = (yield this.unary()) as Expr;
    while (this.at("*") || this.at("/") || this.at("%")) {
      const op = this.next().kind as "*" | "/" | "%";
      const right = (yield this.unary()) as Expr;
      const held = this.lookahead.has(right);
      left = { kind: "binary", op, left, right, range: this.span(first), at: this.lineToken(held) };
      if (held) this.lookahead.add(left);
    }
    return left;
  }

  /** unary = ("+"|"-") unary | primary */
  private *unary(): Task<Expr> {
    const first = this.peek();
    if (first.kind === "+" || first.kind === "-") {
      this.next();
      const operand = (yield this.unary()) as Expr;
      const held = this.lookahead.has(operand);
      const node: Expr = { kind: "unary", op: first.kind, operand, range: this.span(first), at: this.lineToken(held) };
      if (held) this.lookahead.add(node);
      return node;
    }
    return (yield this.primary()) as Expr;
  }

  /** primary = int | char | "(" expr ")" | id "(" args ")" | lvalue */
  private *primary(): Task<Expr> {
    const t = this.peek();
    switch (t.kind) {
      case "int":
        this.next();
        return { kind: "int", value: Number(t.text), range: t.range };
      case "char":
        this.next();
        return { kind: "char", text: t.text, range: t.range };
      case "(": {
        this.next();
        const inner = (yield this.expr()) as Expr;
        this.expect(")");
        // The ")" is read, so nothing is held after the parentheses.
        this.lookahead.delete(inner);
        return inner;
      }
      case "id":
        return (yield this.peek(1).kind === "(" ? this.call() : this.lvalue()) as Expr;
      case "string":
        return (yield this.lvalue()) as Expr;
      default:
        return this.fail("an expression");
    }
  }

  // ---- conditions ---------------------------------------------------------

  /** cond = andCond {"|" andCond} */
  private *cond(): Task<Cond> {
    const first = this.peek();
    let left = (yield this.andCond()) as Cond;
    while (this.eat("|")) {
      const right = (yield this.andCond()) as Cond;
      left = { kind: "logic", op: "|", left, right, range: this.span(first) };
    }
    return left;
  }

  /** andCond = notCond {"&" notCond} */
  private *andCond(): Task<Cond> {
    const first = this.peek();
    let left = (yield this.notCond()) as Cond;
    while (this.eat("&")) {
      const right = (yield this.notCond()) as Cond;
      left = { kind: "logic", op: "&", left, right, range: this.span(first) };
    }
    return left;
  }

  /** notCond = "!" notCond | condAtom */
  private *notCond(): Task<Cond> {
    const first = this.peek();
    if (this.eat("!")) {
      const operand = (yield this.notCond()) as Cond;
      return { kind: "not", operand, range: this.span(first) };
    }
    return (yield this.condAtom()) as Cond;
  }

  /** condAtom = "true" | "false" | "(" cond ")" | expr relop expr */
  private *condAtom(): Task<Cond> {
    const first = this.peek();
    if (this.eat("kw_true")) return { kind: "bool", value: true, range: first.range };
    if (this.eat("kw_false")) return { kind: "bool", value: false, range: first.range };
    if (first.kind !== "(") return (yield this.comparison()) as Cond;
    const tried = (yield this.parenCond()) as Cond | ParenFailure;
    if (!("failedAt" in tried)) return tried;
    const saved = { diagnostics: this.diagnostics.length, errors: this.errorCount };
    try {
      return (yield this.comparison()) as Cond;
    } catch (e) {
      // Both readings failed. Keep the error of the one that got further.
      if (e instanceof ParseError && tried.failedAt > this.pos) {
        this.pos = tried.failedAt;
        this.truncateDiagnostics(saved.diagnostics);
        for (const d of tried.diagnostics) this.add(d);
        this.errorCount = saved.errors + tried.errors;
      }
      throw e;
    }
  }

  /** expr relop expr */
  private *comparison(): Task<Cond> {
    const first = this.peek();
    const left = (yield this.expr()) as Expr;
    const opTok = this.peek();
    if (!REL_OPS.has(opTok.kind)) this.fail("a comparison operator");
    this.next();
    const right = (yield this.expr()) as Expr;
    return { kind: "compare", op: opTok.kind as RelOp, left, right, range: this.span(first), at: this.lineToken(true) };
  }

  /**
   * Tries "(" cond ")" at a "(". When that does not parse, or when an
   * operator follows the ")" (the parentheses then belong to an expression
   * such as "(x + 1) * 2 > 3"), it rewinds and returns what the failed try
   * reported, with the token index where it stopped (-1 when it parsed).
   */
  private *parenCond(): Task<Cond | ParenFailure> {
    const saved = { pos: this.pos, diagnostics: this.diagnostics.length, errors: this.errorCount };
    let inner: Cond | undefined;
    try {
      this.next();
      inner = (yield this.cond()) as Cond;
      this.expect(")");
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
    }
    const k = this.peek().kind;
    const failed = this.errorCount > saved.errors;
    if (inner && !failed && !REL_OPS.has(k) && !ARITH_OPS.has(k)) return inner;
    const result = {
      failedAt: failed ? this.pos : -1,
      diagnostics: this.diagnostics.slice(saved.diagnostics),
      errors: this.errorCount - saved.errors,
    };
    this.pos = saved.pos;
    this.truncateDiagnostics(saved.diagnostics);
    this.errorCount = saved.errors;
    return result;
  }
}

export function parse(src: string): { program?: FuncDecl; diagnostics: Diagnostic[] } {
  const { tokens, errors } = lex(src);
  const diagnostics: Diagnostic[] = errors.map((e) => ({
    message: e.message, range: e.range, severity: "error", source: "alan",
  }));
  const parser = new Parser(tokens, diagnostics);
  let program: FuncDecl | undefined;
  try {
    program = run(parser.program());
  } catch (e) {
    parser.internalError(e);
  }
  diagnostics.sort((a, b) => comparePos(a.range.start, b.range.start));
  return program ? { program, diagnostics } : { diagnostics };
}
