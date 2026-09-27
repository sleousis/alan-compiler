// Turns `alanc check` into LSP diagnostics. The extension client runs this
// on save and sends the result to the server as alan/compilerDiagnostics,
// which merges it with the live diagnostics. It needs no VS Code API.
import * as path from "node:path";
import type { Diagnostic, DiagnosticSeverity } from "vscode-languageserver";
import { CompilerRef, commandLine, failureSummary, parseCompilerOutput, runCompiler } from "../client/compiler";

export const CHECK_TIMEOUT_MS = 20_000;

const ERROR: DiagnosticSeverity = 1;

/**
 * Diagnostics for the compiler's errors in text. Each one covers its line
 * from the first non-blank character. A line past the end of the text
 * lands on the last line. With a non-zero exitCode and no error on a
 * line, the failure itself goes on the first line, so a failed check never
 * looks clean.
 */
export function compilerDiagnostics(stderr: string, fileBase: string, text: string, exitCode?: number | null): Diagnostic[] {
  const lines = text.split(/\r\n|\r|\n/);
  let found = parseCompilerOutput(stderr, fileBase);
  if (!found.length && typeof exitCode === "number" && exitCode !== 0) {
    found = [{ line: 0, message: failureSummary(stderr) ?? `alanc check failed with exit status ${exitCode}.` }];
  }
  return found.map(({ line, message }) => {
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
 * undefined when the compiler could not run, did not finish in time or was
 * aborted, so the caller keeps what it showed before. log hears why,
 * except for an abort.
 */
export async function checkFile(
  c: CompilerRef, file: string, text: string, opts: { signal?: AbortSignal; log?: (line: string) => void } = {},
): Promise<Diagnostic[] | undefined> {
  const log = opts.log ?? (() => {});
  let cl: { cmd: string; args: string[] };
  try {
    cl = commandLine(c, "check", file, { optimize: false });
  } catch (e) {
    log(`Check of ${file} skipped: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
  const r = await runCompiler(cl.cmd, cl.args, { timeoutMs: CHECK_TIMEOUT_MS, signal: opts.signal });
  if (r.failure === "aborted") return undefined;
  if (r.failure) {
    const why = r.failure === "timeout" ? `no answer in ${CHECK_TIMEOUT_MS / 1000} s`
      : r.failure === "missing" ? `${cl.cmd} not found` : r.detail ?? "unknown error";
    log(`Check of ${file} failed: ${why}`);
    return undefined;
  }
  return compilerDiagnostics(r.stderr, path.basename(file), text, r.code);
}
