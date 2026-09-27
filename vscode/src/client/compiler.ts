// Finds the Alan compiler, builds its command lines and reads its errors.
// Everything here except findCompiler runs without VS Code, so the unit tests
// cover it directly. Arguments always go to the compiler as an array, never
// through a shell command line, so paths with spaces, quotes or non-ASCII
// letters reach it unchanged.
import { ChildProcess, spawn } from "node:child_process";
import { statSync } from "node:fs";
import * as path from "node:path";
import type * as vscode from "vscode";
import { installedCompilerPath, isOlderTag, MIN_COMPILER } from "./installer";
import { toWslPath } from "./wsl";

export interface CompilerRef {
  /** The compiler executable. In WSL mode a Linux path or a name looked up on the Linux PATH. */
  exe: string;
  /** True when the compiler runs inside WSL through wsl.exe. */
  wsl: boolean;
}

/** "ir" prints LLVM IR: alanc <file> [-O]. */
export type Verb = "check" | "build" | "run" | "ir";

/**
 * The script wsl.exe runs. It puts ~/.local/bin, where the installer puts
 * alanc, in front of PATH and runs "$0" "$@". The arguments stay separate
 * words: wsl.exe -e does not join them into a shell command line, which
 * `wsl.exe --` does, and that breaks on spaces and quotes.
 */
export const WSL_LAUNCH = 'PATH="$HOME/.local/bin:$PATH"; exec "$0" "$@"';

const ANSI = /\u001b\[[0-9;]*m/g;
const ABORT_LINE = "The alan compiler is lazy and aborts...";

/** text without its terminal colour codes. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Reads the compiler's `<fileBase>:<line>: error: <message>` lines (also
 * fatal and internal errors) into 0-based lines. Colour codes, other files
 * and lines without a line number are ignored.
 */
export function parseCompilerOutput(stderr: string, fileBase: string): { line: number; message: string }[] {
  const re = new RegExp(`^${escapeRegExp(fileBase)}:(\\d+): (?:error|fatal|internal): (.*)$`);
  const out: { line: number; message: string }[] = [];
  for (const raw of stderr.replace(ANSI, "").split(/\r?\n/)) {
    const m = re.exec(raw);
    if (m) out.push({ line: Math.max(0, Number(m[1]) - 1), message: m[2].trim() });
  }
  return out;
}

/** The first line of the compiler's error output worth showing to the user. */
export function failureSummary(stderr: string): string | undefined {
  return stderr.replace(ANSI, "").split(/\r?\n/).map((l) => l.trim()).find((l) => l && l !== ABORT_LINE);
}

export function commandLine(
  c: CompilerRef, verb: Verb, file: string, opts: { optimize: boolean; out?: string; debug?: boolean },
): { cmd: string; args: string[] } {
  const p = c.wsl ? toWslPath : (s: string) => s;
  const args = verb === "ir" ? [p(file)] : [verb, p(file)];
  if (verb === "build" && opts.out) args.push("-o", p(opts.out));
  // -g turns -O off in the compiler, so a debug build never asks for both.
  if ((verb === "build" || verb === "run") && opts.debug) args.push("-g");
  else if (verb !== "check" && opts.optimize) args.push("-O");
  if (c.wsl) return { cmd: "wsl.exe", args: ["-e", "sh", "-c", WSL_LAUNCH, c.exe, ...args] };
  return { cmd: c.exe, args };
}

/**
 * Where Build puts the program: next to the source, named like the
 * compiler's own default (h.alan gives h.exe on Windows and h elsewhere,
 * inside WSL too). It never equals the source.
 */
export function buildOutputPath(file: string, wsl: boolean, platform: NodeJS.Platform): string {
  const suffix = platform === "win32" && !wsl ? ".exe" : "";
  const cut = platform === "win32" ? Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) : file.lastIndexOf("/");
  const base = file.slice(cut + 1);
  if (base.endsWith(".alan") && base.length > 5) return file.slice(0, -5) + suffix;
  return file + (suffix || ".out");
}

/** True when the document must go through Save As before the compiler can read it. */
export function needsSaveAs(d: { isUntitled: boolean; scheme: string; existsOnDisk: boolean }): boolean {
  return d.isUntitled || d.scheme !== "file" || !d.existsOnDisk;
}

/** Looks name up on a PATH string, adding .exe on Windows. */
export function searchPath(
  name: string, envPath: string, platform: NodeJS.Platform, isFile: (p: string) => boolean,
): string | undefined {
  const win = platform === "win32";
  const paths = win ? path.win32 : path.posix;
  for (let dir of envPath.split(win ? ";" : ":")) {
    if (win) dir = dir.replace(/^"(.*)"$/, "$1");
    if (!dir) continue;
    const candidate = paths.join(dir, win ? `${name}.exe` : name);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

export interface LocateOptions {
  /** The alan.compilerPath setting, trimmed. Empty means not set. */
  compilerPath: string;
  /** The alan.useWsl setting. Other platforms ignore it, as settings sync can bring it from Windows. */
  useWsl: boolean;
  platform: NodeJS.Platform;
  /** The installed compiler (Task 14), if any. */
  installed?: string;
  envPath: string;
}

/**
 * Chooses the compiler: in WSL mode the setting or alanc on the Linux PATH.
 * Otherwise the setting if it names a file, else the installed copy, else
 * alanc on PATH. A setting that names a missing file finds nothing, so the
 * user notices the wrong setting.
 */
export function locateCompiler(o: LocateOptions, isFile: (p: string) => boolean): CompilerRef | undefined {
  if (o.useWsl && o.platform === "win32") return { exe: o.compilerPath || "alanc", wsl: true };
  if (o.compilerPath) return isFile(o.compilerPath) ? { exe: o.compilerPath, wsl: false } : undefined;
  if (o.installed && isFile(o.installed)) return { exe: o.installed, wsl: false };
  const onPath = searchPath("alanc", o.envPath, o.platform, isFile);
  return onPath ? { exe: onPath, wsl: false } : undefined;
}

export interface RunResult {
  /** Exit status, or null when the process did not finish normally. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the compiler could not run or did not finish. */
  failure?: "missing" | "timeout" | "aborted" | "error";
  detail?: string;
}

/**
 * Stops pid and every process it started. alanc runs zig, which runs its
 * own children, and killing alanc alone would leave them writing into the
 * output folder. On POSIX the compiler runs in its own process group.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    const taskkill = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
    // taskkill fails when it cannot start or cannot stop the tree. Then at least alanc goes.
    taskkill.on("error", () => child.kill());
    taskkill.on("exit", (code) => {
      if (code !== 0) child.kill();
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** How long to wait for the output to close after killing the process tree. */
const KILL_GRACE_MS = 5000;

/**
 * Runs cmd with an argument array (no shell) and collects its output.
 * A timeout, an abort or too much output kills the process with all its
 * children.
 */
export function runCompiler(
  cmd: string, args: string[], opts: { timeoutMs: number; cwd?: string; maxBuffer?: number; signal?: AbortSignal },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let settled = false;
    let stopped: Pick<RunResult, "failure" | "detail"> | undefined;
    const maxBuffer = opts.maxBuffer ?? 16 * 1024 * 1024;
    const text = (b: Buffer[]) => Buffer.concat(b).toString("utf8");
    let timer: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    const onAbort = () => stop({ failure: "aborted", detail: "The operation was aborted" });

    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    if (opts.signal?.aborted) return finish({ code: null, stdout: "", stderr: "", failure: "aborted", detail: "aborted before start" });

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
      });
    } catch (e) {
      return finish({ code: null, stdout: "", stderr: "", failure: "error", detail: e instanceof Error ? e.message : String(e) });
    }

    function stop(why: Pick<RunResult, "failure" | "detail">): void {
      if (stopped || settled) return;
      stopped = why;
      killTree(child);
      // Output pipes a stray grandchild holds open must not keep the caller waiting.
      grace = setTimeout(() => finish({ code: null, stdout: text(out), stderr: text(err), ...why }), KILL_GRACE_MS);
    }

    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBuffer) return stop({ failure: "error", detail: "the compiler's output is too large" });
      into.push(chunk);
    };
    child.stdout?.on("data", collect(out));
    child.stderr?.on("data", collect(err));
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return finish({ code: null, stdout: "", stderr: "", failure: "missing", detail: e.message });
      finish({ code: null, stdout: text(out), stderr: text(err), failure: "error", detail: e.message });
    });
    child.on("close", (code, signal) => {
      const r = { code: stopped ? null : code, stdout: text(out), stderr: text(err) };
      if (stopped) return finish({ ...r, ...stopped });
      if (code === null) return finish({ ...r, failure: "error", detail: `the compiler was stopped by ${signal ?? "a signal"}` });
      finish(r);
    });
    timer = setTimeout(() => stop({ failure: "timeout", detail: `no answer within ${opts.timeoutMs} ms` }), opts.timeoutMs);
    opts.signal?.addEventListener("abort", onAbort);
  });
}

function isFile(p: string): boolean {
  try {
    return statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

/** Compilers inside WSL that answered, so each save does not start WSL twice. */
const wslFound = new Set<string>();

/** Forgets what findCompiler and compilerVersion learned, after the settings or the installed copy change. */
export function forgetCompiler(): void {
  wslFound.clear();
  versions.clear();
}

/**
 * What `alanc --version` says about a compiler. "old" is a version below
 * MIN_COMPILER, or a compiler without --version (before 2.0), which exits
 * non-zero or prints something else. "unknown" means it could not tell:
 * the compiler did not start or did not answer in time.
 */
export type VersionCheck =
  | { status: "ok"; version: string }
  | { status: "old"; version?: string }
  | { status: "unknown"; detail?: string };

/** How long `alanc --version` may take. WSL can take a while to start. */
const VERSION_TIMEOUT_MS = 5000;
const WSL_VERSION_TIMEOUT_MS = 15000;

/** Reads the answer to `alanc --version`, whose first line is `alanc <version>`. */
export function versionCheck(r: RunResult): VersionCheck {
  if (r.failure) return { status: "unknown", detail: r.detail };
  const m = /^alanc (\S+)\s*$/.exec(stripAnsi(r.stdout).split(/\r?\n/)[0] ?? "");
  if (r.code !== 0 || !m) return { status: "old" };
  const version = m[1];
  // A build from source without a release version says dev.
  if (version === "dev" || !isOlderTag(version, MIN_COMPILER)) return { status: "ok", version };
  return { status: "old", version };
}

/** Answers of `--version`, by the compiler file and its modification time, or by the WSL name. */
const versions = new Map<string, { mtimeMs: number; check: VersionCheck }>();

/**
 * Runs cmd with args (a compiler with --version) once for each version of
 * the file key, and remembers a clear answer. A changed modification time
 * asks again. Exported for the tests, which use fake compilers.
 */
export async function probeVersion(
  key: string, cmd: string, args: string[], opts: { timeoutMs: number; wsl?: boolean },
): Promise<VersionCheck> {
  let mtimeMs = 0;
  if (!opts.wsl) {
    try {
      mtimeMs = statSync(key).mtimeMs;
    } catch (e) {
      return { status: "unknown", detail: e instanceof Error ? e.message : String(e) };
    }
  }
  const id = opts.wsl ? `wsl:${key}` : key;
  const known = versions.get(id);
  if (known && known.mtimeMs === mtimeMs) return known.check;
  const check = versionCheck(await runCompiler(cmd, args, { timeoutMs: opts.timeoutMs }));
  if (check.status !== "unknown") versions.set(id, { mtimeMs, check });
  return check;
}

/** Asks the compiler ref for its version with `alanc --version`. */
export function compilerVersion(ref: CompilerRef): Promise<VersionCheck> {
  if (ref.wsl) {
    return probeVersion(ref.exe, "wsl.exe", ["-e", "sh", "-c", WSL_LAUNCH, ref.exe, "--version"],
      { timeoutMs: WSL_VERSION_TIMEOUT_MS, wsl: true });
  }
  return probeVersion(ref.exe, ref.exe, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS });
}

async function wslHas(exe: string): Promise<boolean> {
  if (wslFound.has(exe)) return true;
  const script = 'PATH="$HOME/.local/bin:$PATH"; command -v "$0" >/dev/null';
  const r = await runCompiler("wsl.exe", ["-e", "sh", "-c", script, exe], { timeoutMs: 15000 });
  if (r.code !== 0) return false;
  wslFound.add(exe);
  return true;
}

export async function findCompiler(ctx: vscode.ExtensionContext): Promise<CompilerRef | undefined> {
  // Required here, not imported at the top, so the rest of this file runs in
  // unit tests without VS Code. A dynamic import() would miss the module
  // that the extension host provides to require.
  const { workspace } = require("vscode") as typeof import("vscode");
  const cfg = workspace.getConfiguration("alan");
  const platform = process.platform;
  const useWsl = platform === "win32" && cfg.get<boolean>("useWsl", false);
  const ref = locateCompiler({
    compilerPath: cfg.get<string>("compilerPath", "").trim(),
    useWsl,
    platform,
    installed: useWsl ? undefined : installedCompilerPath(ctx.globalStorageUri.fsPath, platform),
    envPath: process.env.PATH ?? "",
  }, isFile);
  if (ref?.wsl && !(await wslHas(ref.exe))) return undefined;
  return ref;
}
