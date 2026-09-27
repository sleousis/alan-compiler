// Alan lexer for the language server. It mirrors the rules of lexer.l at the
// repository root so the editor reports what the compiler would report.

export type TokenKind =
  | "id" | "int" | "char" | "string"
  | "kw_if" | "kw_else" | "kw_while" | "kw_return" | "kw_int" | "kw_byte"
  | "kw_reference" | "kw_proc" | "kw_true" | "kw_false"
  | "==" | "!=" | "<=" | ">=" | "=" | "!" | "|" | "&" | "<" | ">" | "(" | ")"
  | "[" | "]" | "{" | "}" | "," | ":" | "+" | "-" | "*" | "%" | "/" | ";"
  | "eof" | "bad";
export interface Pos { line: number; character: number; }        // 0-based, LSP style
export interface Range { start: Pos; end: Pos; }
export interface Token { kind: TokenKind; text: string; range: Range; }
export interface LexError { message: string; range: Range; }

const KEYWORDS: Record<string, TokenKind> = {
  if: "kw_if", else: "kw_else", while: "kw_while", return: "kw_return",
  int: "kw_int", byte: "kw_byte", reference: "kw_reference", proc: "kw_proc",
  true: "kw_true", false: "kw_false",
};

const TWO_CHAR_OPS = new Set(["==", "!=", "<=", ">="]);
// The S class of lexer.l plus "=".
const ONE_CHAR_OPS = new Set("!|&<>()[]{},:+-*%/;=");
// Characters a char literal may hold unescaped: L, D, S and space.
const CHAR_SYMBOLS = "!|&<>()[]{},:+-*%/;";
const SIMPLE_ESCAPES = "ntr0\\'\"";

const isLetter = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isDigit = (c: string) => c >= "0" && c <= "9";
const isIdChar = (c: string) => isLetter(c) || isDigit(c) || c === "_";
const isLowerHex = (c: string) => isDigit(c) || (c >= "a" && c <= "f");
const isWhitespace = (c: string) => c === " " || c === "\t" || c === "\r" || c === "\n";

/** Length of a valid char literal starting at src[i] (a quote), or 0 if none. */
function charLiteralLength(src: string, i: number): number {
  const c = src[i + 1];
  if (c === undefined) return 0;
  let body: number;
  if (c === "\\") {
    const e = src[i + 2];
    if (e !== undefined && SIMPLE_ESCAPES.includes(e)) body = 2;
    else if (e === "x" && isLowerHex(src[i + 3] ?? "") && isLowerHex(src[i + 4] ?? "")) body = 4;
    else return 0;
  } else if (isLetter(c) || isDigit(c) || c === " " || CHAR_SYMBOLS.includes(c)) {
    body = 1;
  } else {
    return 0;
  }
  return src[i + 1 + body] === "'" ? body + 2 : 0;
}

export function lex(src: string): { tokens: Token[]; errors: LexError[] } {
  const tokens: Token[] = [];
  const errors: LexError[] = [];
  let i = 0;
  let line = 0;
  let col = 0;

  const pos = (): Pos => ({ line, character: col });

  /** Moves past n characters, counting lines on "\n" only. */
  const advance = (n: number) => {
    for (const end = i + n; i < end; i++) {
      if (src[i] === "\n") { line++; col = 0; } else col++;
    }
  };

  /** Consumes n characters as one token and returns it. */
  const emit = (kind: TokenKind, n: number): Token => {
    const start = pos();
    const text = src.slice(i, i + n);
    advance(n);
    const token = { kind, text, range: { start, end: pos() } };
    tokens.push(token);
    return token;
  };

  const emitBad = (n: number, message: string) => {
    const token = emit("bad", n);
    errors.push({ message, range: token.range });
  };

  /** Index of the next "\n" at or after `from`, or the end of the source. */
  const lineEnd = (from: number) => {
    const nl = src.indexOf("\n", from);
    return nl < 0 ? src.length : nl;
  };

  /**
   * Skips a "(* ... *)" comment starting at i. Comments nest, and anything
   * other than "(*" and "*)" inside them is plain text. An unterminated
   * comment is reported at its outermost opener, as lexer.l does.
   */
  const skipBlockComment = () => {
    const start = pos();
    advance(2);
    let depth = 1;
    while (depth > 0 && i < src.length) {
      const two = src.slice(i, i + 2);
      if (two === "(*") { depth++; advance(2); }
      else if (two === "*)") { depth--; advance(2); }
      else advance(1);
    }
    if (depth > 0) {
      errors.push({
        message: "Unterminated comment",
        range: { start, end: { line: start.line, character: start.character + 2 } },
      });
    }
  };

  while (i < src.length) {
    const c = src[i];

    if (isWhitespace(c)) { advance(1); continue; }

    if (c === "-" && src[i + 1] === "-") { advance(lineEnd(i) - i); continue; }

    if (c === "(" && src[i + 1] === "*") { skipBlockComment(); continue; }

    if (isLetter(c)) {
      let j = i + 1;
      while (j < src.length && isIdChar(src[j])) j++;
      emit(KEYWORDS[src.slice(i, j)] ?? "id", j - i);
      continue;
    }

    if (isDigit(c)) {
      let j = i + 1;
      while (j < src.length && isDigit(src[j])) j++;
      if (j < src.length && isLetter(src[j])) {
        while (j < src.length && isIdChar(src[j])) j++;
        emitBad(j - i, "Illegal phrase");
      } else {
        emit("int", j - i);
      }
      continue;
    }

    if (c === '"') {
      // lexer.l: \"(\\.|[^"\\])*\" but the editor ends a string at the line end.
      let j = i + 1;
      while (j < src.length && src[j] !== '"' && src[j] !== "\n") {
        j += src[j] === "\\" && src[j + 1] !== undefined && src[j + 1] !== "\n" ? 2 : 1;
      }
      if (src[j] === '"') emit("string", j + 1 - i);
      else emitBad(j - i, "Unterminated string");
      continue;
    }

    if (c === "'") {
      const n = charLiteralLength(src, i);
      if (n > 0) { emit("char", n); continue; }
      // Not a valid literal: take up to the next quote on this line as one bad token.
      const end = lineEnd(i);
      let j = i + 1;
      while (j < end && src[j] !== "'") j += src[j] === "\\" ? 2 : 1;
      if (j < end) emitBad(j + 1 - i, "Illegal character literal");
      else emitBad(end - i, "Unterminated character literal");
      continue;
    }

    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) { emit(two as TokenKind, 2); continue; }
    if (ONE_CHAR_OPS.has(c)) { emit(c as TokenKind, 1); continue; }

    // A surrogate pair is one character to the user.
    const code = src.charCodeAt(i);
    const width = code >= 0xd800 && code <= 0xdbff && i + 1 < src.length ? 2 : 1;
    emitBad(width, "Illegal character");
  }

  const end = pos();
  tokens.push({ kind: "eof", text: "", range: { start: end, end } });
  return { tokens, errors };
}
