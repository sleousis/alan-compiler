// Turns `alanc check` into LSP diagnostics. The extension client runs this
// on save and sends the result to the server as alan/compilerDiagnostics,
// which merges it with the live diagnostics. It needs no VS Code API.
import * as path from "node:path";
import type { Diagnostic, DiagnosticSeverity } from "vscode-languageserver";
import { CompilerRef, commandLine, parseCompilerOutput, runCompiler } from "../client/compiler";

export const CHECK_TIMEOUT_MS = 20_000;

const ERROR: DiagnosticSeverity = 1;

/**
 * Diagnostics for the compiler's errors in text. Each one covers its line
 * from the first non-blank character. A line past the end of the text
 * lands on the last line.
 */
export function compilerDiagnostics(stderr: string, fileBase: string, text: string): Diagnostic[] {
  const lines = text.split(/\r\n|\r|\n/);
  return parseCompilerOutput(stderr, fileBase).map(({ line, message }) => {
    const n = Math.min(line, lines.length - 1);
    const content = lines[n];
    const start = Math.max(0, content.search(/\S/));
    return {
      range: { start: { line: n, character: start }, end: { line: n, character: content.length } },
      message,
      severity: ERROR,
      source: "alanc",
    };
  });
}

/**
 * Runs `alanc check` on file, whose saved content is text. Returns
 * undefined when the compiler could not run or did not finish in time, so
 * the caller keeps what it showed before.
 */
export async function checkFile(c: CompilerRef, file: string, text: string): Promise<Diagnostic[] | undefined> {
  let cl: { cmd: string; args: string[] };
  try {
    cl = commandLine(c, "check", file, { optimize: false });
  } catch {
    return undefined; // a path WSL cannot open
  }
  const r = await runCompiler(cl.cmd, cl.args, { timeoutMs: CHECK_TIMEOUT_MS });
  if (r.failure) return undefined;
  return compilerDiagnostics(r.stderr, path.basename(file), text);
}
