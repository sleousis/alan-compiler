// Syntax tree built by parser.ts. Every node carries the source range from its
// first to its last token. Char and string literals keep their source text,
// quotes and escapes included, so a printer can reproduce them exactly.
import { Range } from "./lexer";

export type DataType = "int" | "byte";
export interface TypeRef { base: DataType; array: boolean; range: Range; }
export interface Param { name: string; nameRange: Range; byRef: boolean; type: TypeRef; }
export interface VarDecl { kind: "var"; name: string; nameRange: Range; type: DataType; size?: number; range: Range; }
export interface FuncDecl {
  kind: "func"; name: string; nameRange: Range; params: Param[];
  ret: DataType | "proc"; locals: (FuncDecl | VarDecl)[]; body: Block; range: Range;
}
export interface Block { kind: "block"; stmts: Stmt[]; range: Range; }
export type Stmt =
  | { kind: "empty"; range: Range }
  | { kind: "assign"; target: LValue; value: Expr; range: Range }
  | Block
  | { kind: "call"; call: Call; range: Range }
  | { kind: "if"; cond: Cond; then: Stmt; else?: Stmt; range: Range }
  | { kind: "while"; cond: Cond; body: Stmt; range: Range }
  | { kind: "return"; value?: Expr; range: Range };
export type LValue =
  | { kind: "name"; name: string; range: Range }
  | { kind: "index"; name: string; nameRange: Range; index: Expr; range: Range }
  | { kind: "string"; value: string; range: Range };
export interface Call { kind: "call"; name: string; nameRange: Range; args: Expr[]; range: Range; }
export type Expr =
  | { kind: "int"; value: number; range: Range }
  | { kind: "char"; text: string; range: Range }
  | LValue | Call
  | { kind: "unary"; op: "+" | "-"; operand: Expr; range: Range }
  | { kind: "binary"; op: "+" | "-" | "*" | "/" | "%"; left: Expr; right: Expr; range: Range };
export type Cond =
  | { kind: "bool"; value: boolean; range: Range }
  | { kind: "not"; operand: Cond; range: Range }
  | { kind: "compare"; op: "==" | "!=" | "<" | ">" | "<=" | ">="; left: Expr; right: Expr; range: Range }
  | { kind: "logic"; op: "&" | "|"; left: Cond; right: Cond; range: Range };
/** Codes of the name errors found by scopes.ts. Lexer and parser errors carry no code. */
export type NameErrorCode = "duplicate" | "unknown-name" | "not-an-array" | "not-a-variable" | "not-a-function" | "argument-count";
export interface Diagnostic {
  message: string; range: Range; severity: "error" | "warning"; source: "alan"; code?: NameErrorCode;
}
