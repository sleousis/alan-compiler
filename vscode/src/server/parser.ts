// Recursive descent parser for Alan. It follows the grammar of parser.y at the
// repository root and keeps going after errors, so the editor can show every
// problem in a file at once and still build a tree for the rest of it.
import {
  Block, Call, Cond, DataType, Diagnostic, Expr, FuncDecl, LValue, Param, Stmt, TypeRef, VarDecl,
} from "./ast";
import { Pos, Range, Token, TokenKind, lex } from "./lexer";

/** Thrown after an error is reported. The nearest statement or declaration catches it and resyncs. */
class ParseError {}

type RelOp = Extract<Cond, { kind: "compare" }>["op"];

/** Deepest nesting of blocks, statements, parentheses and functions the parser follows. */
const MAX_DEPTH = 500;
const TOO_DEEP = "Nesting is too deep";

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
  /** Current nesting depth, see nested(). */
  private depth = 0;
  /** Start positions that already carry a diagnostic. */
  private readonly reported: Set<string>;

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
   * Records an error unless it sits on a bad token (the lexer already said
   * why) or another error already starts at the same position.
   */
  private report(message: string, range: Range, token?: Token) {
    this.errorCount++;
    if (token?.kind === "bad") return;
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

  /**
   * Runs one level of nesting. Past MAX_DEPTH it reports "Nesting is too
   * deep" (once per file), skips the bracketed group that starts here and
   * fails, so the stack never overflows and normal recovery takes over.
   */
  private nested<T>(parse: () => T): T {
    if (this.depth >= MAX_DEPTH) {
      const t = this.peek();
      if (this.diagnostics.some((d) => d.message === TOO_DEEP)) this.errorCount++;
      else this.report(TOO_DEEP, t.range, t);
      if (t.kind === "(" || t.kind === "{") this.skipGroup(t.kind, t.kind === "(" ? ")" : "}");
      throw new ParseError();
    }
    this.depth++;
    try {
      return parse();
    } finally {
      this.depth--;
    }
  }

  /** Skips from an opening bracket past its matching closing one, or to the end of the file. */
  private skipGroup(open: TokenKind, close: TokenKind) {
    let level = 0;
    do {
      const k = this.next().kind;
      if (k === open) level++;
      else if (k === close) level--;
      else if (k === "eof") return;
    } while (level > 0);
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

  program(): FuncDecl | undefined {
    let program: FuncDecl | undefined;
    if (!this.at("id")) {
      this.unexpected("a function definition");
      this.next();
      while (!this.at("eof") && !(this.at("id") && this.peek(1).kind === "(")) this.next();
    }
    if (this.at("id")) program = this.funcDef();
    if (!this.at("eof")) this.unexpected("end of file");
    return program;
  }

  /** funcDef = id "(" [param {"," param}] ")" ":" (dataType | "proc") {localDef} block */
  private funcDef(): FuncDecl {
    const nameTok = this.next();
    const params: Param[] = [];
    let ret: DataType | "proc" = "proc";
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
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      this.syncDecl(headerStart);
    }

    const locals: (FuncDecl | VarDecl)[] = [];
    while (!this.at("{") && !this.at("eof")) {
      const from = this.pos;
      try {
        if (this.at("id") && this.peek(1).kind === "(") locals.push(this.nested(() => this.funcDef()));
        else if (this.at("id") && this.peek(1).kind === ":") locals.push(this.varDef());
        else if (this.at("id")) { this.next(); this.fail("':' or '('"); }
        else this.fail("'{'");
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.syncDecl(from);
      }
    }

    let body: Block;
    if (this.at("{")) body = this.block();
    else {
      this.unexpected("'{'");
      body = { kind: "block", stmts: [], range: this.peek().range };
    }
    return {
      kind: "func", name: nameTok.text, nameRange: nameTok.range, params, ret, locals, body,
      range: this.span(nameTok),
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
    if (this.eat("[")) { this.expect("]"); array = true; }
    const type: TypeRef = { base, array, range: this.span(typeStart) };
    return { name: nameTok.text, nameRange: nameTok.range, byRef, type };
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
    const decl: VarDecl = { kind: "var", name: nameTok.text, nameRange: nameTok.range, type, range: this.span(nameTok) };
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
  private block(): Block {
    const open = this.next();
    const stmts: Stmt[] = [];
    while (!this.at("}") && !this.at("eof")) {
      const s = this.stmt();
      if (s) stmts.push(s);
    }
    if (!this.eat("}")) this.unexpected("'}'");
    return { kind: "block", stmts, range: this.span(open) };
  }

  /** Parses one statement, or skips a broken one and returns undefined. */
  private stmt(): Stmt | undefined {
    const from = this.pos;
    try {
      return this.stmtOrThrow();
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      this.syncStmt(from);
      return undefined;
    }
  }

  /** A statement that must be there, such as the body of an if. A broken one becomes empty. */
  private innerStmt(): Stmt {
    const first = this.peek();
    const from = this.pos;
    let s: Stmt | undefined;
    try {
      s = this.nested(() => this.stmt());
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      this.syncStmt(this.pos);
    }
    if (s) return s;
    const at = first.range.start;
    return { kind: "empty", range: this.pos > from ? this.span(first) : { start: at, end: at } };
  }

  private stmtOrThrow(): Stmt {
    const first = this.peek();
    switch (first.kind) {
      case ";":
        this.next();
        return { kind: "empty", range: first.range };
      case "{":
        return this.nested(() => this.block());
      case "kw_if": {
        this.next();
        this.expect("(");
        const cond = this.cond();
        this.expect(")");
        const then = this.innerStmt();
        if (this.eat("kw_else")) {
          const otherwise = this.innerStmt();
          return { kind: "if", cond, then, else: otherwise, range: this.span(first) };
        }
        return { kind: "if", cond, then, range: this.span(first) };
      }
      case "kw_while": {
        this.next();
        this.expect("(");
        const cond = this.cond();
        this.expect(")");
        const body = this.innerStmt();
        return { kind: "while", cond, body, range: this.span(first) };
      }
      case "kw_return": {
        this.next();
        const value = this.atExprStart() ? this.expr() : undefined;
        this.expectSemicolon();
        return value ? { kind: "return", value, range: this.span(first) } : { kind: "return", range: this.span(first) };
      }
      case "id":
        if (this.peek(1).kind === "(") {
          const call = this.call();
          this.expectSemicolon();
          return { kind: "call", call, range: this.span(first) };
        }
        return this.assignment();
      case "string":
        return this.assignment();
      default:
        return this.fail("a statement");
    }
  }

  /** lvalue "=" expr ";" */
  private assignment(): Stmt {
    const first = this.peek();
    const target = this.lvalue();
    this.expect("=", target.kind === "name" ? "'=', '[' or '('" : "'='");
    const value = this.expr();
    this.expectSemicolon();
    return { kind: "assign", target, value, range: this.span(first) };
  }

  /** lvalue = id ["[" expr "]"] | string */
  private lvalue(): LValue {
    const t = this.next();
    if (t.kind === "string") return { kind: "string", value: t.text, range: t.range };
    if (this.eat("[")) {
      const index = this.expr();
      this.expect("]");
      return { kind: "index", name: t.text, nameRange: t.range, index, range: this.span(t) };
    }
    return { kind: "name", name: t.text, range: t.range };
  }

  /** id "(" [expr {"," expr}] ")" */
  private call(): Call {
    const nameTok = this.next();
    this.next();
    const args: Expr[] = [];
    if (!this.at(")")) {
      args.push(this.expr());
      while (this.eat(",")) args.push(this.expr());
    }
    this.expect(")", "',' or ')'");
    return { kind: "call", name: nameTok.text, nameRange: nameTok.range, args, range: this.span(nameTok) };
  }

  // ---- expressions --------------------------------------------------------

  private atExprStart(): boolean {
    const k = this.peek().kind;
    return k === "int" || k === "char" || k === "string" || k === "id" || k === "(" || k === "+" || k === "-";
  }

  /** expr = term {("+"|"-") term} */
  private expr(): Expr {
    const first = this.peek();
    let left = this.term();
    while (this.at("+") || this.at("-")) {
      const op = this.next().kind as "+" | "-";
      const right = this.term();
      left = { kind: "binary", op, left, right, range: this.span(first) };
    }
    return left;
  }

  /** term = unary {("*"|"/"|"%") unary} */
  private term(): Expr {
    const first = this.peek();
    let left = this.unary();
    while (this.at("*") || this.at("/") || this.at("%")) {
      const op = this.next().kind as "*" | "/" | "%";
      const right = this.unary();
      left = { kind: "binary", op, left, right, range: this.span(first) };
    }
    return left;
  }

  /** unary = ("+"|"-") unary | primary */
  private unary(): Expr {
    const first = this.peek();
    if (first.kind === "+" || first.kind === "-") {
      this.next();
      const operand = this.nested(() => this.unary());
      return { kind: "unary", op: first.kind, operand, range: this.span(first) };
    }
    return this.primary();
  }

  /** primary = int | char | "(" expr ")" | id "(" args ")" | lvalue */
  private primary(): Expr {
    const t = this.peek();
    switch (t.kind) {
      case "int":
        this.next();
        return { kind: "int", value: Number(t.text), range: t.range };
      case "char":
        this.next();
        return { kind: "char", text: t.text, range: t.range };
      case "(":
        return this.nested(() => {
          this.next();
          const inner = this.expr();
          this.expect(")");
          return inner;
        });
      case "id":
        return this.peek(1).kind === "(" ? this.call() : this.lvalue();
      case "string":
        return this.lvalue();
      default:
        return this.fail("an expression");
    }
  }

  // ---- conditions ---------------------------------------------------------

  /** cond = andCond {"|" andCond} */
  private cond(): Cond {
    const first = this.peek();
    let left = this.andCond();
    while (this.eat("|")) {
      const right = this.andCond();
      left = { kind: "logic", op: "|", left, right, range: this.span(first) };
    }
    return left;
  }

  /** andCond = notCond {"&" notCond} */
  private andCond(): Cond {
    const first = this.peek();
    let left = this.notCond();
    while (this.eat("&")) {
      const right = this.notCond();
      left = { kind: "logic", op: "&", left, right, range: this.span(first) };
    }
    return left;
  }

  /** notCond = "!" notCond | condAtom */
  private notCond(): Cond {
    const first = this.peek();
    if (this.eat("!")) {
      const operand = this.nested(() => this.notCond());
      return { kind: "not", operand, range: this.span(first) };
    }
    return this.condAtom();
  }

  /** condAtom = "true" | "false" | "(" cond ")" | expr relop expr */
  private condAtom(): Cond {
    const first = this.peek();
    if (this.eat("kw_true")) return { kind: "bool", value: true, range: first.range };
    if (this.eat("kw_false")) return { kind: "bool", value: false, range: first.range };
    if (first.kind !== "(") return this.comparison();
    const tried = this.nested(() => this.parenCond());
    if (!("failedAt" in tried)) return tried;
    const saved = { diagnostics: this.diagnostics.length, errors: this.errorCount };
    try {
      return this.comparison();
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
  private comparison(): Cond {
    const first = this.peek();
    const left = this.expr();
    const opTok = this.peek();
    if (!REL_OPS.has(opTok.kind)) this.fail("a comparison operator");
    this.next();
    const right = this.expr();
    return { kind: "compare", op: opTok.kind as RelOp, left, right, range: this.span(first) };
  }

  /**
   * Tries "(" cond ")" at a "(". When that does not parse, or when an
   * operator follows the ")" (the parentheses then belong to an expression
   * such as "(x + 1) * 2 > 3"), it rewinds and returns what the failed try
   * reported, with the token index where it stopped (-1 when it parsed).
   */
  private parenCond(): Cond | { failedAt: number; diagnostics: Diagnostic[]; errors: number } {
    const saved = { pos: this.pos, diagnostics: this.diagnostics.length, errors: this.errorCount };
    let inner: Cond | undefined;
    try {
      this.next();
      inner = this.cond();
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
    program = parser.program();
  } catch (e) {
    parser.internalError(e);
  }
  diagnostics.sort((a, b) => comparePos(a.range.start, b.range.start));
  return program ? { program, diagnostics } : { diagnostics };
}
