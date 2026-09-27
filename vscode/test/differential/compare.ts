// Differential test: the language server against the real compiler. For
// every file, the error the server would report first (line and message)
// must be the error `alanc check` reports, and a file the compiler accepts
// must get no error at all.
//
// Run from the vscode folder:
//   ALANC=/path/to/alanc npm run test:diff [-- more.alan more/dir ...]
// With ALANC_WSL=1 the compiler runs inside WSL and ALANC is its Linux path.
// It checks every tracked file in Examples, tests/regress and tests/errors,
// the probes next to this file, the nesting probes of nesting-probes.ts
// (written to a temporary folder), and the files and folders given as
// arguments. Each probe holds one case where the compiler's line or message
// is easy to get wrong, such as a name whose statement ends on the next line.
//
// One difference is by design. Bison says only "syntax error". There the
// server must report an error of its own parser on the same line, or a
// missing ";" on an earlier line, where the server puts it at the end of the
// token before.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commandLine, parseCompilerOutput, runCompiler } from "../../src/client/compiler";
import { analyzeSource } from "../../src/server/analysis";
import { computeDiagnostics, firstError } from "../../src/server/diagnostics";
import { writeNestingProbes } from "./nesting-probes";

const repo = path.resolve(__dirname, "../../..");
const exe = process.env.ALANC;
if (!exe) {
  console.error("Set ALANC to the alanc to compare with.");
  process.exit(2);
}
const compiler = { exe, wsl: process.env.ALANC_WSL === "1" };

interface Found { line: number; message: string; }
const show = (e?: Found) => (e ? `${e.line + 1}: ${e.message}` : "no error");

async function check(file: string): Promise<Found[]> {
  const { cmd, args } = commandLine(compiler, "check", file, { optimize: false });
  const r = await runCompiler(cmd, args, { timeoutMs: 60_000 });
  if (r.failure) throw new Error(`${file}: alanc did not run: ${r.detail}`);
  const found = parseCompilerOutput(r.stderr, path.basename(file));
  if (r.code !== 0 && found.length === 0) throw new Error(`${file}: alanc failed without an error line:\n${r.stderr}`);
  return found;
}

function server(file: string): { first?: Found; all: Found[]; parserError: boolean } {
  const source = analyzeSource(fs.readFileSync(file, "utf8"));
  const first = firstError(source);
  const all = computeDiagnostics(source).map((d) => ({ line: d.range.start.line, message: d.message }));
  const parserError = !!first && first.code === undefined && source.syntax.includes(first) && isParserMessage(first.message);
  return { first: first && { line: first.range.start.line, message: first.message }, all, parserError };
}

/** Messages of the editor's own parser, which bison reports as "syntax error". */
function isParserMessage(message: string): boolean {
  return /^expected .* but found /.test(message);
}

function files(): string[] {
  const tracked = execFileSync("git", ["ls-files", "Examples", "tests/regress", "tests/errors"], { cwd: repo, encoding: "utf8" })
    .split("\n").filter((f) => f && (f.startsWith("Examples/") ? !f.endsWith(".md") : f.endsWith(".alan")));
  const out = tracked.map((f) => path.join(repo, f));
  out.push(...writeNestingProbes(path.join(os.tmpdir(), "alan-nesting-probes")));
  for (const arg of [path.join(__dirname, "probes"), ...process.argv.slice(2)]) {
    const p = path.resolve(arg);
    if (fs.statSync(p).isDirectory()) {
      for (const f of fs.readdirSync(p).sort()) if (f.endsWith(".alan")) out.push(path.join(p, f));
    } else out.push(p);
  }
  return out;
}

async function main() {
  const list = files();
  // A few compilers at a time: every WSL start takes a moment.
  const results: { file: string; compiler: Found[]; server: ReturnType<typeof server> }[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < list.length) {
      const i = next++;
      results[i] = { file: list[i], compiler: await check(list[i]), server: server(list[i]) };
    }
  }));
  let failed = 0;
  for (const { file, compiler: c, server: s } of results) {
    const name = path.relative(repo, file);
    let verdict: "same" | "DIFFERENT";
    if (c.length === 0) {
      verdict = s.all.length === 0 ? "same" : "DIFFERENT";
    } else if (c.length > 1) {
      verdict = JSON.stringify(c) === JSON.stringify(s.all) ? "same" : "DIFFERENT";
    } else if (c[0].message === "syntax error") {
      const sameLine = s.first?.line === c[0].line;
      const semicolonBefore = !!s.first && s.first.line < c[0].line && s.first.message.startsWith("expected ';'");
      verdict = s.parserError && (sameLine || semicolonBefore) ? "same" : "DIFFERENT";
    } else {
      verdict = s.first?.line === c[0].line && s.first.message === c[0].message ? "same" : "DIFFERENT";
    }
    if (verdict === "DIFFERENT") failed++;
    const detail = verdict === "same" && c.length === 0 ? "" : `  compiler: ${show(c[0])}  server: ${show(s.first)}`;
    console.log(`${verdict === "same" ? "ok  " : "FAIL"} ${name}${detail}`);
  }
  console.log(`\n${results.length} files, ${results.length - failed} same, ${failed} different.`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
});
