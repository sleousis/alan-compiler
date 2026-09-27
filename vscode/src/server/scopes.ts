// Name resolution for Alan. It follows ast_sem in ast.cpp and the symbol
// table in symbol.cpp at the repository root:
// - Each function opens a scope that holds its own name, its parameters and
//   its locals, in that order. Its name also enters the enclosing scope once
//   the function ends.
// - Parameters and locals may shadow outer names, but not share a name with
//   anything in their own scope, the function's own name included.
// - A nested function may not reuse any name visible where it is declared.
// - A call looks through every scope and then the library. A plain name never
//   finds a library function. It finds a user function everywhere except in
//   the body of the function that declares it, because the compiler files the
//   name in that scope at the nesting level of the function's own scope.
// It works on partial trees from files with syntax errors and never throws.
import { Call, Cond, Diagnostic, Expr, FuncDecl, Stmt, VarDecl } from "./ast";
import { LIBRARY } from "./library";
import { Pos, Range } from "./lexer";

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
export interface Analysis { root: Scope; diagnostics: Diagnostic[]; references: { name: string; range: Range; target?: Sym }[]; }

const comparePos = (a: Pos, b: Pos) => a.line - b.line || a.character - b.character;
const contains = (r: Range, p: Pos) => comparePos(r.start, p) <= 0 && comparePos(p, r.end) <= 0;
const isFunction = (s: Sym) => s.kind === "function" || s.kind === "library";

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

class Analyzer {
  readonly diagnostics: Diagnostic[] = [];
  readonly references: Analysis["references"] = [];
  /** Parameters and variables that hold an array, for the index check. */
  private readonly arrays = new Set<Sym>();

  private error(message: string, range: Range) {
    this.diagnostics.push({ message, range, severity: "error", source: "alan" });
  }

  /** Adds a parameter or local to a scope unless the name is already there. */
  private declare(scope: Scope, sym: Sym, range: Range) {
    if (scope.symbols.has(sym.name)) this.error(`'${sym.name}' is already declared in this scope`, range);
    else scope.symbols.set(sym.name, sym);
  }

  private lookup(scope: Scope, name: string): { sym: Sym; scope: Scope } | undefined {
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      const sym = s.symbols.get(name);
      if (sym) return { sym, scope: s };
    }
    return undefined;
  }

  func(f: FuncDecl, parent: Scope) {
    // Like newFunction: the name may not match anything visible in the user's scopes.
    let clash = false;
    for (let s: Scope | undefined = parent; s?.owner; s = s.parent) {
      if (!s.symbols.has(f.name)) continue;
      const where = s === parent ? "this scope" : "an enclosing function";
      this.error(`'${f.name}' is already declared in ${where}`, f.nameRange);
      clash = true;
      break;
    }

    const scope: Scope = { owner: f, parent, symbols: new Map(), children: [], range: f.range };
    parent.children.push(scope);
    const self = functionSym(f);
    scope.symbols.set(f.name, self);

    f.params.forEach((p, i) => {
      const sym: Sym = { name: p.name, kind: "parameter", typeText: self.params![i].type, range: p.nameRange };
      if (p.type.array) this.arrays.add(sym);
      this.declare(scope, sym, p.nameRange);
    });

    for (const local of f.locals) {
      if (local.kind === "func") {
        this.func(local, scope);
        continue;
      }
      const typeText = local.size === undefined ? local.type : `${local.type}[${local.size}]`;
      const sym: Sym = { name: local.name, kind: "variable", typeText, range: local.nameRange, decl: local };
      if (local.size !== undefined) this.arrays.add(sym);
      this.declare(scope, sym, local.nameRange);
    }

    this.stmt(f.body, scope);
    if (parent.owner && !clash) parent.symbols.set(f.name, self);
  }

  private stmt(s: Stmt, scope: Scope) {
    switch (s.kind) {
      case "block":
        for (const inner of s.stmts) this.stmt(inner, scope);
        break;
      case "assign":
        this.walk(s.target, scope);
        this.walk(s.value, scope);
        break;
      case "call":
        this.walk(s.call, scope);
        break;
      case "if":
        this.walk(s.cond, scope);
        this.stmt(s.then, scope);
        if (s.else) this.stmt(s.else, scope);
        break;
      case "while":
        this.walk(s.cond, scope);
        this.stmt(s.body, scope);
        break;
      case "return":
        if (s.value) this.walk(s.value, scope);
        break;
      case "empty":
        break;
    }
  }

  /** Walks an expression or condition with an explicit stack, since operator chains can be very long. */
  private walk(root: Expr | Cond, scope: Scope) {
    const stack: (Expr | Cond)[] = [root];
    while (stack.length) {
      const e = stack.pop()!;
      switch (e.kind) {
        case "name":
          this.useName(e.name, e.range, scope, false);
          break;
        case "index":
          this.useName(e.name, e.nameRange, scope, true);
          stack.push(e.index);
          break;
        case "call":
          this.useCall(e, scope);
          for (let i = e.args.length - 1; i >= 0; i--) stack.push(e.args[i]);
          break;
        case "unary":
        case "not":
          stack.push(e.operand);
          break;
        case "binary":
        case "compare":
        case "logic":
          stack.push(e.right, e.left);
          break;
        default:
          break;
      }
    }
  }

  private useName(name: string, range: Range, scope: Scope, indexed: boolean) {
    const found = this.lookup(scope, name);
    this.references.push(found ? { name, range, target: found.sym } : { name, range });
    if (!found) return this.error(`Unknown name '${name}'`, range);
    const { sym } = found;
    if (indexed) {
      if (!this.arrays.has(sym)) this.error(`'${name}' is not an array`, range);
    } else if (sym.kind === "library" || (sym.kind === "function" && found.scope === scope && sym.decl !== scope.owner)) {
      // The compiler misses a nested function by plain name only in the body that declares it.
      this.error(`'${name}' is a function, not a variable`, range);
    }
  }

  private useCall(call: Call, scope: Scope) {
    const found = this.lookup(scope, call.name);
    this.references.push(found ? { name: call.name, range: call.nameRange, target: found.sym } : { name: call.name, range: call.nameRange });
    if (!found) return this.error(`Unknown name '${call.name}'`, call.nameRange);
    const { sym } = found;
    if (!isFunction(sym)) return this.error(`'${call.name}' is not a function`, call.nameRange);
    const want = sym.params?.length ?? 0;
    if (want !== call.args.length) {
      this.error(`'${call.name}' expects ${want} argument${want === 1 ? "" : "s"} but got ${call.args.length}`, call.nameRange);
    }
  }
}

export function analyze(program: FuncDecl): Analysis {
  const root: Scope = { symbols: new Map(LIBRARY.map((f) => [f.name, librarySym(f)])), children: [], range: program.range };
  const analyzer = new Analyzer();
  analyzer.func(program, root);
  analyzer.diagnostics.sort((a, b) => comparePos(a.range.start, b.range.start));
  return { root, diagnostics: analyzer.diagnostics, references: analyzer.references };
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
 * declared before the inner function count.
 */
export function visible(scope: Scope): Sym[] {
  const seen = new Set<string>();
  const out: Sym[] = [];
  let limit: Pos | undefined;
  for (let s: Scope | undefined = scope; s; s = s.parent) {
    for (const sym of [...s.symbols.values()].reverse()) {
      if (seen.has(sym.name)) continue;
      if (limit && sym.range && comparePos(sym.range.start, limit) >= 0) continue;
      seen.add(sym.name);
      out.push(sym);
    }
    limit = s.range.start;
  }
  return out;
}
