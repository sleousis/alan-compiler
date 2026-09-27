// Alan lexer for the language server. It mirrors the rules of lexer.l at the
// repository root so the editor reports what the compiler would report.
import { MSG } from "./messages";

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
/** A comment kept by lex(src, { keepComments: true }). Block comments include their nested parts. */
export interface Comment { text: string; range: Range; block: boolean; }
export interface LexOptions { keepComments?: boolean; }

const KEYWORDS: Record<string, TokenKind> = {
  if: "kw_if", else: "kw_else", while: "kw_while", return: "kw_return",
  int: "kw_int", byte: "kw_byte", reference: "kw_reference", proc: "kw_proc",
  true: "kw_true", false: "kw_false",
};

const TWO_CHAR_OPS = new Set(["==", "!=", "<=", ">="]);
// The S class of lexer.l plus "=".
const ONE_CHAR_OPS = new Set("!|&<>()[]{},:+-*%/;=");
const SIMPLE_ESCAPES = "ntr0\\'\"";
/** The largest int constant: int is 32 bits. */
const INT_MAX = 2147483647n;

const isLetter = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isDigit = (c: string) => c >= "0" && c <= "9";
const isIdChar = (c: string) => isLetter(c) || isDigit(c) || c === "_";
const isHex = (c: string) => isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
const isWhitespace = (c: string) => c === " " || c === "\t" || c === "\r" || c === "\n";
/** The C class of lexer.l: printable ASCII except the two quotes and the backslash. */
const isCommonChar = (c: string) => c >= " " && c <= "~" && c !== "'" && c !== "\"" && c !== "\\";

/** Length of the escape sequence (E in lexer.l) at the backslash src[i], or 0 if there is none. */
function escapeLength(src: string, i: number): number {
  const e = src[i + 1];
  if (e !== undefined && SIMPLE_ESCAPES.includes(e)) return 2;
  if (e === "x" && isHex(src[i + 2] ?? "") && isHex(src[i + 3] ?? "")) return 4;
  return 0;
}

/** Length of a valid char literal starting at src[i] (a quote), or 0 if none. */
function charLiteralLength(src: string, i: number): number {
  const c = src[i + 1];
  if (c === undefined) return 0;
  const body = c === "\\" ? escapeLength(src, i + 1) : isCommonChar(c) ? 1 : 0;
  return body > 0 && src[i + 1 + body] === "'" ? body + 2 : 0;
}

/**
 * Reads the string literal at src[i] (a quote) as lexer.l does. Its body
 * holds escapes and any character but the quote, a backslash, a line break
 * and NUL. Gives the index just past the closing quote, or the index where
 * the body stops and the error lexer.l reports there.
 */
function readString(src: string, i: number): { end: number } | { stop: number; message: string } {
  let j = i + 1;
  for (;;) {
    const c = src[j];
    if (c === "\"") return { end: j + 1 };
    if (c === "\\") {
      const n = escapeLength(src, j);
      if (n > 0) { j += n; continue; }
      // lexer.l names the character after the backslash, unless it is a line break or NUL.
      // A CRLF line end is a line break too, as the compiler reads text files on Windows.
      const next = src[j + 1];
      const lineBreak = next === "\n" || (next === "\r" && src[j + 2] === "\n");
      const named = next === undefined || lineBreak || next === "\u0000" ? "" : next;
      return { stop: j, message: MSG.invalidEscape(named) };
    }
    if (c === undefined || c === "\n") return { stop: j, message: MSG.stringNotClosed };
    if (c === "\u0000") return { stop: j, message: MSG.nulInString };
    j++;
  }
}

export function lex(src: string, options: LexOptions = {}): { tokens: Token[]; errors: LexError[]; comments?: Comment[] } {
  const tokens: Token[] = [];
  const errors: LexError[] = [];
  const comments: Comment[] | undefined = options.keepComments ? [] : undefined;
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

  /**
   * Index where the line holding `from` ends: the next "\n", or the "\r" of a
   * "\r\n", or the end of the source. CRLF and LF files then give the same tokens.
   */
  const lineEnd = (from: number) => {
    const nl = src.indexOf("\n", from);
    if (nl < 0) return src.length;
    return nl > from && src[nl - 1] === "\r" ? nl - 1 : nl;
  };

  /**
   * Skips a "(* ... *)" comment starting at i. Comments nest, and anything
   * other than "(*" and "*)" inside them is plain text. An unterminated
   * comment is reported at its outermost opener, as lexer.l does.
   */
  const skipBlockComment = () => {
    const start = pos();
    const from = i;
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
        message: MSG.unterminatedComment,
        range: { start, end: { line: start.line, character: start.character + 2 } },
      });
    }
    comments?.push({ text: src.slice(from, i), range: { start, end: pos() }, block: true });
  };

  /** Skips a "--" comment starting at i, up to the end of its line. */
  const skipLineComment = () => {
    const start = pos();
    const from = i;
    advance(lineEnd(i) - i);
    comments?.push({ text: src.slice(from, i), range: { start, end: pos() }, block: false });
  };

  while (i < src.length) {
    const c = src[i];

    if (isWhitespace(c)) { advance(1); continue; }

    if (c === "-" && src[i + 1] === "-") { skipLineComment(); continue; }

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
        emitBad(j - i, MSG.illegalPhrase);
      } else {
        // The token stays an int, so the rest of the statement still parses.
        const token = emit("int", j - i);
        if (BigInt(token.text) > INT_MAX) errors.push({ message: MSG.intOutOfRange(token.text), range: token.range });
      }
      continue;
    }

    if (c === "\"") {
      const read = readString(src, i);
      if ("end" in read) { emit("string", read.end - i); continue; }
      // A broken string becomes one bad token, up to its closing quote on this line if it has one.
      const end = lineEnd(i);
      const close = src.indexOf("\"", read.stop + 1);
      const tokenEnd = read.message === MSG.stringNotClosed ? end : close >= 0 && close < end ? close + 1 : end;
      const from = i;
      const token = emit("bad", tokenEnd - i);
      // An escape or NUL is marked where it is, on the line where the string starts.
      const start = token.range.start;
      const at = { line: start.line, character: start.character + read.stop - from };
      const width = read.message === MSG.nulInString ? 1 : Math.min(2, tokenEnd - read.stop);
      const range = read.message === MSG.stringNotClosed
        ? token.range : { start: at, end: { line: at.line, character: at.character + width } };
      errors.push({ message: read.message, range });
      continue;
    }

    if (c === "'") {
      const n = charLiteralLength(src, i);
      if (n > 0) { emit("char", n); continue; }
      // Not a valid literal: take up to the next quote on this line as one bad token.
      const end = lineEnd(i);
      let j = i + 1;
      while (j < end && src[j] !== "'") j += src[j] === "\\" && j + 1 < end ? 2 : 1;
      emitBad((j < end ? j + 1 : end) - i, MSG.invalidChar);
      continue;
    }

    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) { emit(two as TokenKind, 2); continue; }
    if (ONE_CHAR_OPS.has(c)) { emit(c as TokenKind, 1); continue; }

    // A surrogate pair is one character to the user.
    const code = src.charCodeAt(i);
    const width = code >= 0xd800 && code <= 0xdbff && i + 1 < src.length ? 2 : 1;
    emitBad(width, MSG.illegalCharacter);
  }

  const end = pos();
  tokens.push({ kind: "eof", text: "", range: { start: end, end } });
  return comments ? { tokens, errors, comments } : { tokens, errors };
}
