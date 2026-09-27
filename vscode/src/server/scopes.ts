// Name resolution and semantic checks for Alan. It follows ast_sem in ast.cpp
// and the symbol table in symbol.cpp at the repository root, and reports the
// compiler's messages on the compiler's lines:
// - As in Pascal, a function's name goes in the enclosing scope when its
//   header is read, and its parameters and locals go in a scope of its own.
//   The program's function has its name in the root scope, next to the
//   library.
// - A duplicate is a name that is already in the same scope. So a parameter
//   may share its function's name, and nested functions and locals may
//   shadow any outer name, the parent's name included.
// - Names enter the table in source order, so a name is visible from where
//   it is declared: a function sees its parent's names declared before it,
//   and its ancestors' earlier functions.
// - A plain name never finds a library function. A call looks through every
//   scope first and then the library, so a user function declared after a
//   call does not hide a library function at that call.
// The compiler stops at its first error. The checks here go on after an
// error and skip only the checks that depend on the failed one, so each
// error they report is one the compiler would report once the earlier ones
// are fixed. The diagnostics come in the order the compiler meets them.
// It works on partial trees from files with syntax errors and never throws.
// The walks are generators run by trampoline.ts, since nesting may be deep.
import { Call, Cond, Diagnostic, Expr, FuncDecl, LValue, SemanticCode, Stmt, VarDecl } from "./ast";
import { LIBRARY } from "./library";
import { Pos, Range } from "./lexer";
import { MSG, TypeWord } from "./messages";
import { checkNesting } from "./nesting";
import { Task, run } from "./trampoline";

export type SymbolKind = "function" | "parameter" | "variable" | "library";
/**
 * A declared name. typeText is Alan text: "int[4]" for a variable,
 * "reference byte[]" for a parameter, the return type for a function.
 */
export interface Sym {
  name: string; kind: SymbolKind; typeText: string; range?: Range;
  params?: { name: string; type: string }[]; decl?: FuncDecl | VarDecl;
}
export interface Scope { owner?: FuncDecl; parent?: Scope; symbols: Map<string, Sym>; children: Scope[]; range: Range; }
/** diagnostics are in the order the compiler meets them, so the first one is the error `alanc check` reports. */
export interface Analysis { root: Scope; diagnostics: Diagnostic[]; references: { name: string; range: Range; target?: Sym }[]; }

/** A type as the compiler sees it: a base and whether it is an array. A proc call has type void. */
interface Type { base: "int" | "byte" | "void"; array: boolean; }

const INT: Type = { base: "int", array: false };
const BYTE: Type = { base: "byte", array: false };
const VOID: Type = { base: "void", array: false };

const comparePos = (a: Pos, b: Pos) => a.line - b.line || a.character - b.character;
const contains = (r: Range, p: Pos) => comparePos(r.start, p) <= 0 && comparePos(p, r.end) <= 0;
const isFunction = (s: Sym) => s.kind === "function" || s.kind === "library";
/** The name of a type in operator and parameter messages, where a proc call has type proc. */
const typeName = (t: Type): TypeWord => (t.base === "void" ? "proc" : t.base);

/** A parameter type written as Alan text, such as "reference byte[]". */
function parseParamType(text: string): { type: Type; byRef: boolean } {
  const byRef = text.startsWith("reference ");
  const rest = byRef ? text.slice("reference ".length) : text;
  const array = rest.endsWith("[]");
  const base = array ? rest.slice(0, -2) : rest;
  return { type: { base: base === "byte" ? "byte" : "int", array }, byRef };
}

function resultType(ret: string): Type {
  return ret === "int" ? INT : ret === "byte" ? BYTE : VOID;
}

function librarySym(f: typeof LIBRARY[number]): Sym {
  return { name: f.name, kind: "library", typeText: f.ret, params: f.params.map((p) => ({ ...p })) };
}

function functionSym(f: FuncDecl): Sym {
  const params = f.params.map((p) => ({
    name: p.name,
    type: `${p.byRef ? "reference " : ""}${p.type.base}${p.type.array ? "[]" : ""}`,
  }));
  return { name: f.name, kind: "function", typeText: f.ret, range: f.nameRange, params, decl: f };
}

/** The range to mark: the node itself when it starts on the compiler's line, else the token that gives that line. */
function place(natural: Range, at: Range): Range {
  return natural.start.line === at.start.line ? natural : at;
}

class Analyzer {
  readonly diagnostics: Diagnostic[] = [];
  readonly references: Analysis["references"] = [];
  /** Types of parameters and variables. */
  private readonly types = new Map<Sym, Type>();

  private error(code: SemanticCode, message: string, range: Range) {
    this.diagnostics.push({ message, range, severity: "error", source: "alan", code });
  }

  /** Adds a name to a scope, like newEntry: a name already in that scope is a duplicate. */
  private declare(scope: Scope, sym: Sym, range: Range) {
    if (scope.symbols.has(sym.name)) this.error("duplicate", MSG.duplicate(sym.name), range);
    else scope.symbols.set(sym.name, sym);
  }

  /** Finds a name from a scope outwards. Library functions are found only when `library` is set. */
  private lookup(scope: Scope, name: string, library: boolean): Sym | undefined {
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      const sym = s.symbols.get(name);
      if (sym && (library || sym.kind !== "library")) return sym;
    }
    return undefined;
  }

  private reference(name: string, range: Range, target: Sym | undefined) {
    this.references.push(target ? { name, range, target } : { name, range });
  }

  /** Checks a function definition, like checkFunction. The root scope holds the library. */
  *func(f: FuncDecl, parent: Scope): Task<void> {
    const header = place(f.nameRange, f.at);
    const outermost = !parent.owner;
    if (outermost && f.params.length > 0) this.error("declaration", MSG.mainParameters(f.name), header);
    const self = functionSym(f);
    // The program's function has an outer scope of its own, so it cannot clash with the library.
    if (outermost) parent.symbols.set(f.name, self);
    else this.declare(parent, self, header);

    const scope: Scope = { owner: f, parent, symbols: new Map(), children: [], range: f.range };
    parent.children.push(scope);

    f.params.forEach((p, i) => {
      if (p.type.array && !p.byRef) this.error("declaration", MSG.arrayByValue(f.name), place(p.type.range, p.at));
      const sym: Sym = { name: p.name, kind: "parameter", typeText: self.params![i].type, range: p.nameRange };
      this.types.set(sym, { base: p.type.base, array: p.type.array });
      this.declare(scope, sym, place(p.nameRange, p.at));
    });

    for (const local of f.locals) {
      if (local.kind === "func") {
        yield this.func(local, scope);
        continue;
      }
      if (local.size !== undefined && local.size <= 0) this.error("declaration", MSG.arraySize, place(local.range, local.at));
      const typeText = local.size === undefined ? local.type : `${local.type}[${local.size}]`;
      const sym: Sym = { name: local.name, kind: "variable", typeText, range: local.nameRange, decl: local };
      this.types.set(sym, { base: local.type, array: local.size !== undefined });
      this.declare(scope, sym, place(local.nameRange, local.at));
    }

    yield this.stmt(f.body, scope, f);
  }

  private *stmt(s: Stmt, scope: Scope, f: FuncDecl): Task<void> {
    switch (s.kind) {
      case "block":
        for (const inner of s.stmts) yield this.stmt(inner, scope, f);
        break;
      case "assign": {
        const left = (yield this.lvalue(s.target, scope)) as Type | undefined;
        const right = (yield this.expr(s.value, scope)) as Type | undefined;
        if (!left || !right) break;
        const range = place(s.range, s.at);
        if (left.array || right.array) this.error("type", MSG.assignArray, range);
        else if (left.base !== right.base) this.error("type", MSG.assignTypes(left.base, right.base), range);
        break;
      }
      case "call":
        yield this.call(s.call, scope, true);
        break;
      case "if":
        yield this.cond(s.cond, scope);
        yield this.stmt(s.then, scope, f);
        if (s.else) yield this.stmt(s.else, scope, f);
        break;
      case "while":
        yield this.cond(s.cond, scope);
        yield this.stmt(s.body, scope, f);
        break;
      case "return":
        yield this.ret(s, scope, f);
        break;
      case "empty":
        break;
    }
  }

  /** Like checkReturn. */
  private *ret(s: Extract<Stmt, { kind: "return" }>, scope: Scope, f: FuncDecl): Task<void> {
    const range = place(s.range, s.at);
    const want = resultType(f.ret);
    if (want.base === "void" && s.value) {
      this.error("type", MSG.procReturnsValue(f.name), range);
      yield this.expr(s.value, scope);
      return;
    }
    const got = s.value ? (yield this.expr(s.value, scope)) as Type | undefined : VOID;
    if (!got) return;
    if (got.array) this.error("type", MSG.returnArray, range);
    else if (got.base !== want.base) this.error("type", MSG.mustReturn(f.name, want.base), range);
  }

  /** Like checkElement and checkName: the type of an l-value, or undefined after an error. */
  private *lvalue(e: LValue, scope: Scope): Task<Type | undefined> {
    switch (e.kind) {
      case "string":
        return { base: "byte", array: true };
      case "name":
        return this.name(e.name, e.range, e.at, scope);
      case "index": {
        // The name of an element has the element's line.
        const array = this.name(e.name, e.nameRange, e.at, scope);
        if (array && !array.array) {
          this.error("not-an-array", MSG.expectedArray, place(e.nameRange, e.at));
          yield this.expr(e.index, scope);
          return undefined;
        }
        const index = (yield this.expr(e.index, scope)) as Type | undefined;
        if (!array) return undefined;
        if (index && (index.base !== "int" || index.array)) this.error("type", MSG.indexNotInt, place(e.index.range, e.at));
        return { base: array.base, array: false };
      }
    }
  }

  /** Like checkName: the type of a plain name, or undefined after an error. */
  private name(name: string, range: Range, at: Range, scope: Scope): Type | undefined {
    const sym = this.lookup(scope, name, false);
    this.reference(name, range, sym);
    if (!sym) {
      this.error("unknown-name", MSG.identifierNotFound(name), place(range, at));
      return undefined;
    }
    if (isFunction(sym)) {
      this.error("not-a-variable", MSG.functionAsValue(name), place(range, at));
      return undefined;
    }
    return this.types.get(sym);
  }

  /**
   * Like checkCall: the result type of a call, or undefined when the name is
   * no function. A call statement must call a proc.
   */
  private *call(c: Call, scope: Scope, statement = false): Task<Type | undefined> {
    const sym = this.lookup(scope, c.name, true);
    this.reference(c.name, c.nameRange, sym);
    const at = (natural: Range) => place(natural, c.at);
    const self = this;
    function* walkArgs(from: number): Task<void> {
      for (const a of c.args.slice(from)) yield self.expr(a, scope);
    }
    if (!sym) {
      this.error("unknown-name", MSG.functionNotDeclared(c.name), at(c.nameRange));
      yield walkArgs(0);
      return undefined;
    }
    if (!isFunction(sym)) {
      this.error("not-a-function", MSG.notAFunction(c.name), at(c.nameRange));
      yield walkArgs(0);
      return undefined;
    }
    const ret = resultType(sym.typeText);
    if (statement && ret.base !== "void") this.error("type", MSG.resultUnused(c.name, ret.base), at(c.range));
    const params = (sym.params ?? []).map((p) => ({ name: p.name, ...parseParamType(p.type) }));
    if (params.length === 0 && c.args.length > 0) {
      this.error("argument-count", MSG.noParameters(c.name), at(c.nameRange));
      yield walkArgs(0);
      return ret;
    }
    if (params.length > 0 && c.args.length === 0) {
      this.error("argument-count", MSG.needsParameters(c.name), at(c.nameRange));
      return ret;
    }
    for (let i = 0; i < c.args.length; i++) {
      if (i >= params.length) {
        this.error("argument-count", MSG.tooManyArguments(c.name), at(c.nameRange));
        yield walkArgs(i);
        return ret;
      }
      const arg = c.args[i];
      const p = params[i];
      const type = (yield this.expr(arg, scope)) as Type | undefined;
      if (!type) continue;
      if (type.array !== p.type.array) {
        this.error("type", p.type.array ? MSG.arrayExpected(p.name) : MSG.noArraysAllowed(p.name), at(arg.range));
      } else if (type.base !== p.type.base) {
        this.error("type", MSG.parameterType(p.name, typeName(type), typeName(p.type)), at(arg.range));
      } else if (p.byRef && arg.kind !== "name" && arg.kind !== "index" && arg.kind !== "string") {
        // A reference parameter needs an l-value: a variable, a parameter, an element or a string.
        this.error("type", MSG.referenceNeedsLValue(p.name), at(arg.range));
      }
    }
    if (c.args.length < params.length) {
      this.error("argument-count", MSG.tooFewArguments(params[c.args.length].name), at(c.nameRange));
    }
    return ret;
  }

  /**
   * Like checkArithmetic: the type of an expression, or undefined after an
   * error in it. Operator chains nest on the left and can be very long, so
   * the left side is walked in a loop. A unary minus or plus is 0 - x or
   * 0 + x to the compiler, so its left operand is an int.
   */
  private *expr(e: Expr, scope: Scope): Task<Type | undefined> {
    const chain: Extract<Expr, { kind: "binary" | "unary" }>[] = [];
    let first: Expr = e;
    while (first.kind === "binary" || first.kind === "unary") {
      chain.push(first);
      if (first.kind === "unary") break;
      first = first.left;
    }
    let type = first.kind === "unary" ? INT : (yield this.operand(first, scope)) as Type | undefined;
    for (let i = chain.length - 1; i >= 0; i--) {
      const op = chain[i];
      const right = (yield this.expr(op.kind === "unary" ? op.operand : op.right, scope)) as Type | undefined;
      type = this.operands(op.op, type, right, place(op.range, op.at));
    }
    return type;
  }

  /** The type of an expression that is not an operator. */
  private *operand(e: Exclude<Expr, { kind: "binary" | "unary" }>, scope: Scope): Task<Type | undefined> {
    switch (e.kind) {
      case "int":
        return INT;
      case "char":
        return BYTE;
      case "call":
        return (yield this.call(e, scope)) as Type | undefined;
      default:
        return (yield this.lvalue(e, scope)) as Type | undefined;
    }
  }

  /**
   * Like checkOperands: the operands of an arithmetic or relational
   * operator are both int or both byte. Gives the type of the result, the
   * left operand's, or undefined after an error.
   */
  private operands(op: string, left: Type | undefined, right: Type | undefined, range: Range): Type | undefined {
    if (!left || !right) return undefined;
    if (left.array || right.array) this.error("type", MSG.operatorArray(op), range);
    else if (left.base !== right.base) this.error("type", MSG.operatorTypes(op, typeName(left), typeName(right)), range);
    else if (left.base === "void") this.error("type", MSG.operatorKind(op, typeName(left)), range);
    else return left;
    return undefined;
  }

  /** Walks a condition. Chains of & and | nest on the left and can be very long, so this uses a stack. */
  private *cond(root: Cond, scope: Scope): Task<void> {
    const stack: Cond[] = [root];
    while (stack.length) {
      const c = stack.pop()!;
      switch (c.kind) {
        case "not":
          stack.push(c.operand);
          break;
        case "logic":
          stack.push(c.right, c.left);
          break;
        case "compare": {
          const left = (yield this.expr(c.left, scope)) as Type | undefined;
          const right = (yield this.expr(c.right, scope)) as Type | undefined;
          this.operands(c.op, left, right, place(c.range, c.at));
          break;
        }
        case "bool":
          break;
      }
    }
  }
}

export function analyze(program: FuncDecl): Analysis {
  const root: Scope = { symbols: new Map(LIBRARY.map((f) => [f.name, librarySym(f)])), children: [], range: program.range };
  const analyzer = new Analyzer();
  // The compiler checks the nesting before anything else.
  const nesting = checkNesting(program);
  run(analyzer.func(program, root));
  return { root, diagnostics: [...nesting, ...analyzer.diagnostics], references: analyzer.references };
}

/** The innermost function scope around a position, or the root when outside every function. */
export function scopeAt(root: Scope, pos: Pos): Scope {
  let scope = root;
  for (;;) {
    const child = scope.children.find((c) => contains(c.range, pos));
    if (!child) return scope;
    scope = child;
  }
}

/**
 * The names visible in a scope, innermost first and the newest first within
 * a scope, with shadowed names removed. In the enclosing scopes only names
 * declared up to the inner function's own name count.
 */
export function visible(scope: Scope): Sym[] {
  const seen = new Set<string>();
  const out: Sym[] = [];
  let limit: Pos | undefined;
  for (let s: Scope | undefined = scope; s; s = s.parent) {
    for (const sym of [...s.symbols.values()].reverse()) {
      if (seen.has(sym.name)) continue;
      if (limit && sym.range && comparePos(sym.range.start, limit) > 0) continue;
      seen.add(sym.name);
      out.push(sym);
    }
    limit = s.range.start;
  }
  return out;
}
