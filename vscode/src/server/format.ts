// Formatter for Alan. The parsed tree decides where lines start and how deep
// they are indented. The text itself is printed token by token, so nothing but
// whitespace ever changes: parentheses, literals and comments stay as written.
// The result is lexed again and compared with the input before it is returned.
import { Block, FuncDecl, Stmt } from "./ast";
import { Comment, Pos, Range, Token, TokenKind, lex } from "./lexer";
import { parse } from "./parser";

export interface FormatOptions { tabSize: number; insertSpaces: boolean; }

type Item = { token: Token; index: number; range: Range } | { comment: Comment; range: Range };

interface Layout {
  items: Item[];
  /** Output lines, without line endings. */
  lines: string[];
  /** Output start and end of every item, by item position. */
  outStart: Pos[];
  outEnd: Pos[];
  eol: string;
}

const posKey = (p: Pos) => `${p.line}:${p.character}`;
const before = (a: Pos, b: Pos) => a.line < b.line || (a.line === b.line && a.character < b.character);

/** Tokens after which "+" and "-" are binary operators. */
const OPERAND_ENDS = new Set<TokenKind>(["id", "int", "char", "string", ")", "]"]);
const NO_SPACE_BEFORE = new Set<TokenKind>([",", ";", ")", "]"]);

/** Line comments lose trailing spaces. Block comments are kept exactly. */
const commentText = (c: Comment) => (c.block ? c.text : c.text.trimEnd());

const splitLines = (text: string) => text.split(/\r?\n/);

/**
 * Finds the first token of every line and its indent depth, by walking the
 * tree. Tokens that are not in the map continue the line before them.
 */
function lineStarts(program: FuncDecl, tokens: Token[]): { indent: Map<number, number>; headerNames: Set<number> } {
  const byStart = new Map<string, number>();
  const byEnd = new Map<string, number>();
  tokens.forEach((t, i) => { byStart.set(posKey(t.range.start), i); byEnd.set(posKey(t.range.end), i); });
  const find = (map: Map<string, number>, p: Pos) => {
    const i = map.get(posKey(p));
    if (i === undefined) throw new Error(`No token at ${posKey(p)}`);
    return i;
  };
  const indent = new Map<number, number>();
  const headerNames = new Set<number>();
  const mark = (p: Pos, depth: number) => indent.set(find(byStart, p), depth);

  const func = (f: FuncDecl, depth: number) => {
    mark(f.nameRange.start, depth);
    headerNames.add(find(byStart, f.nameRange.start));
    for (const l of f.locals) {
      if (l.kind === "func") func(l, depth + 1);
      else mark(l.range.start, depth + 1);
    }
    block(f.body, depth, false);
  };
  const block = (b: Block, depth: number, joined: boolean) => {
    if (!joined) mark(b.range.start, depth);
    for (const s of b.stmts) stmt(s, depth + 1, false);
    indent.set(find(byEnd, b.range.end), depth);
  };
  /** The body of an if, else or while: a block opens on the same line, anything else goes one deeper. */
  const body = (s: Stmt, depth: number) => {
    if (s.kind === "block") block(s, depth, true);
    else stmt(s, depth + 1, false);
  };
  const stmt = (s: Stmt, depth: number, joined: boolean) => {
    if (s.kind === "block") { block(s, depth, joined); return; }
    if (!joined) mark(s.range.start, depth);
    if (s.kind === "if") {
      body(s.then, depth);
      if (s.else) {
        indent.set(find(byEnd, s.then.range.end) + 1, depth);
        if (s.else.kind === "if") stmt(s.else, depth, true);
        else body(s.else, depth);
      }
    } else if (s.kind === "while") {
      body(s.body, depth);
    }
  };
  func(program, 0);
  return { indent, headerNames };
}

function layout(src: string, opts: FormatOptions): Layout | undefined {
  const parsed = parse(src);
  if (!parsed.program || parsed.diagnostics.length > 0) return undefined;
  const lexed = lex(src, { keepComments: true });
  const tokens = lexed.tokens.filter((t) => t.kind !== "eof");
  const comments = lexed.comments ?? [];
  const { indent, headerNames } = lineStarts(parsed.program, tokens);

  // Tokens and comments in source order.
  const items: Item[] = [];
  let ci = 0;
  tokens.forEach((token, index) => {
    while (ci < comments.length && before(comments[ci].range.start, token.range.start)) {
      items.push({ comment: comments[ci], range: comments[ci].range });
      ci++;
    }
    items.push({ token, index, range: token.range });
  });
  for (; ci < comments.length; ci++) items.push({ comment: comments[ci], range: comments[ci].range });

  const eol = /^[^\n]*\r\n/.test(src) ? "\r\n" : "\n";
  const unit = opts.insertSpaces ? " ".repeat(Math.max(opts.tabSize, 1)) : "\t";
  const isUnary = (i: number) => {
    const k = tokens[i].kind;
    return k === "!" || ((k === "+" || k === "-") && !(i > 0 && OPERAND_ENDS.has(tokens[i - 1].kind)));
  };
  /** Whether a space goes between token a and the token b right after it. */
  const space = (a: number, b: number) => {
    const ka = tokens[a].kind;
    const kb = tokens[b].kind;
    if (ka === "-" && kb === "-") return true;          // "--" would start a comment
    if (NO_SPACE_BEFORE.has(kb) || ka === "(" || ka === "[" || isUnary(a)) return false;
    if (kb === "[") return ka === "kw_int" || ka === "kw_byte";
    if (kb === "(") return ka !== "id" || headerNames.has(a);
    return true;
  };

  const lines: string[] = [];
  const outStart: Pos[] = [];
  const outEnd: Pos[] = [];
  const here = (): Pos => ({ line: lines.length - 1, character: lines[lines.length - 1].length });
  const newLine = (depth: number, blank: boolean) => {
    if (lines.length > 0 && blank) lines.push("");
    lines.push(unit.repeat(depth));
  };
  /** Appends text that may span lines. Later lines are copied as they are. */
  const append = (text: string) => {
    const parts = splitLines(text);
    lines[lines.length - 1] += parts[0];
    lines.push(...parts.slice(1));
  };

  let depth = 0;                 // indent of the last line started by a token
  let breakNext = false;         // the next item must start a new line
  let joinNext = false;          // the next token stays on this line
  let afterOpenBrace = false;    // the current line holds a "{" (no blank line after it)
  let prevToken = -1;
  let prevWasComment = false;

  items.forEach((item, k) => {
    const prev = k > 0 ? items[k - 1] : undefined;
    const blank = !!prev && item.range.start.line - prev.range.end.line >= 2 && !afterOpenBrace;
    const start = (d: number, allowBlank: boolean) => {
      newLine(d, allowBlank);
      afterOpenBrace = false;
      breakNext = false;
    };
    if ("token" in item) {
      const d = indent.get(item.index);
      if (lines.length === 0) start(d ?? 0, false);
      else if (joinNext) lines[lines.length - 1] += " ";
      else if (d !== undefined) start(d, blank && item.token.kind !== "}");
      else if (breakNext) start(depth + 1, false);
      else if (prevWasComment || space(prevToken, item.index)) lines[lines.length - 1] += " ";
      if (d !== undefined) depth = d;
      outStart[k] = here();
      append(item.token.text);
      if (item.token.kind === "{") afterOpenBrace = true;
      joinNext = false;
      prevToken = item.index;
      prevWasComment = false;
    } else {
      const c = item.comment;
      const trailing = !!prev && c.range.start.line === prev.range.end.line;
      if (trailing) {
        lines[lines.length - 1] += " ";
      } else {
        // Own line: the indent of the next token's line, one deeper inside a block
        // that ends there, or a continuation indent inside a statement.
        const next = items.slice(k + 1).find((it): it is Extract<Item, { token: Token }> => "token" in it);
        const d = next ? indent.get(next.index) : 0;
        start(d === undefined ? depth + 1 : next?.token.kind === "}" ? d + 1 : d, blank);
      }
      outStart[k] = here();
      append(commentText(c));
      joinNext = false;
      if (!c.block) breakNext = true;
      else if (!trailing) {
        const next = items[k + 1];
        if (next && next.range.start.line === c.range.end.line) joinNext = "token" in next;
        else breakNext = true;
      }
      prevWasComment = true;
    }
    outEnd[k] = here();
  });

  // Nothing but whitespace may change: the same tokens and the same comments.
  const text = lines.join(eol) + eol;
  const check = lex(text, { keepComments: true });
  const same = check.errors.length === 0
    && check.tokens.length === lexed.tokens.length
    && check.tokens.every((t, i) => t.kind === lexed.tokens[i].kind && t.text === lexed.tokens[i].text)
    && check.comments!.length === comments.length
    && check.comments!.every((c, i) => splitLines(c.text).join("\n") === splitLines(commentText(comments[i])).join("\n"));
  if (!same) return undefined;
  return { items, lines, outStart, outEnd, eol };
}

/** The formatted text, or undefined when the source has syntax errors. */
export function formatDocument(src: string, opts: FormatOptions): string | undefined {
  const l = layout(src, opts);
  return l && l.lines.join(l.eol) + l.eol;
}

/**
 * Formats the lines a range touches, widened to whole source lines and whole
 * output lines, so a statement split over lines is formatted as one.
 */
export function formatRange(src: string, range: Range, opts: FormatOptions): { range: Range; newText: string } | undefined {
  const l = layout(src, opts);
  if (!l) return undefined;
  const { items, outStart, outEnd } = l;
  const first = range.start.line;
  const last = range.end.line > first && range.end.character === 0 ? range.end.line - 1 : range.end.line;
  let i = items.findIndex((it) => it.range.end.line >= first && it.range.start.line <= last);
  if (i < 0) return undefined;
  let j = i;
  while (j + 1 < items.length && items[j + 1].range.start.line <= last) j++;
  const joined = (a: number, b: number) =>
    items[a].range.end.line === items[b].range.start.line || outEnd[a].line === outStart[b].line;
  while (i > 0 && joined(i - 1, i)) i--;
  while (j + 1 < items.length && joined(j, j + 1)) j++;

  const srcLines = splitLines(src);
  const endLine = items[j].range.end.line;
  return {
    range: {
      start: { line: items[i].range.start.line, character: 0 },
      end: { line: endLine, character: srcLines[endLine].length },
    },
    newText: l.lines.slice(outStart[i].line, outEnd[j].line + 1).join(l.eol),
  };
}
