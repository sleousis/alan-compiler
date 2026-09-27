// F5 debugging. The alan debug type builds the file with `alanc build -g`
// into a temporary folder and hands the program to CodeLLDB as an lldb
// launch configuration. The folder goes away when the debug session ends,
// or when the session never starts.
// Everything that talks to VS Code comes in through DebugDeps, so the unit
// tests run this file without VS Code.
import { rmSync } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import { CompilerRef, RunResult, buildOutputPath, commandLine, failureSummary } from "./compiler";

export const WSL_REFUSAL = "Debugging needs the native compiler. Turn off alan.useWsl or use a Remote WSL window.";
export const NO_PROGRAM = 'Set "program" in the launch configuration to the .alan file to debug.';
export const NO_FOLDER = 'Open a folder, or set "program" to the full path of the .alan file to debug.';
export const UNKNOWN_VARIABLE = 'In "program", Alan debugging understands only ${file} and ${workspaceFolder}.';
export const NO_DEBUG_SUPPORT =
  "This Alan compiler cannot build for debugging. Update it with Alan: Install or Update Compiler.";

const PREFIX = "alan-debug-";
/** How long a finished build waits for its session to start. */
export const START_GRACE_MS = 10 * 60_000;
/** Folders older than this, left by an earlier VS Code, are removed at start. */
export const SWEEP_AGE_MS = 24 * 60 * 60_000;

/** The configuration F5 uses without a launch.json, also offered for a new launch.json. */
export const DEFAULT_CONFIG: vscode.DebugConfiguration = {
  type: "alan", request: "launch", name: "Debug Alan file", program: "${file}",
};

/** The CodeLLDB configuration that runs exe in cwd. */
export function lldbLaunchConfig(exe: string, cwd: string, sourceFile: string): vscode.DebugConfiguration {
  return {
    type: "lldb",
    request: "launch",
    name: `Alan: ${path.basename(sourceFile)}`,
    program: exe,
    cwd,
    terminal: "integrated",
    sourceLanguages: ["c"],
    stopOnEntry: false,
  };
}

/** Where the debug build of file goes inside dir: h.alan gives h, or h.exe on Windows. */
export function debugProgramPath(dir: string, file: string, platform: NodeJS.Platform): string {
  return buildOutputPath(path.join(dir, path.basename(file)), false, platform);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Temporary folders of debug builds, each kept while its session runs. */
export class DebugBuilds {
  /** Program path to its folder, for builds whose session has not ended. */
  private readonly running = new Map<string, string>();
  /** Programs whose session has started. */
  private readonly sessions = new Set<string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  /**
   * uid is the user whose folders sweep may remove, undefined on Windows,
   * where the temp folder is per user anyway. Tests pass another.
   */
  constructor(
    private readonly root: string = os.tmpdir(),
    private readonly log: (line: string) => void = () => {},
    private readonly uid: number | undefined = process.getuid?.(),
  ) {}

  /** A new empty folder for one build. */
  create(): Promise<string> {
    return mkdtemp(path.join(this.root, PREFIX));
  }

  /**
   * Keeps dir until the session that runs program ends. A session that has
   * not started within graceMs never will (CodeLLDB is missing or the user
   * cancelled), so the folder goes then.
   */
  built(program: string, dir: string, graceMs = START_GRACE_MS): void {
    this.running.set(program, dir);
    const timer = setTimeout(() => {
      this.timers.delete(program);
      if (!this.sessions.has(program)) void this.ended(program);
    }, graceMs);
    timer.unref?.();
    this.timers.set(program, timer);
  }

  /** Notes that the session running program started. */
  started(program: unknown): void {
    if (typeof program === "string" && this.running.has(program)) this.sessions.add(program);
  }

  /** Removes the folder of the session that ran program. Other programs are left alone. */
  async ended(program: unknown): Promise<void> {
    if (typeof program !== "string") return;
    const dir = this.running.get(program);
    if (!dir) return;
    this.forget(program);
    await this.remove(dir);
  }

  /**
   * Removes dir with everything in it, the macOS <program>.o too. Windows may
   * hold the program for a moment after it exits, so removal retries.
   */
  async remove(dir: string): Promise<void> {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (e) {
      this.log(`Cannot remove the debug build ${dir}: ${message(e)}`);
    }
  }

  /** Removes build folders older than maxAgeMs that no session here uses, left by a VS Code that stopped. */
  async sweep(maxAgeMs = SWEEP_AGE_MS, now = Date.now()): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return;
    }
    const inUse = new Set(this.running.values());
    for (const name of names) {
      if (!name.startsWith(PREFIX)) continue;
      const dir = path.join(this.root, name);
      if (inUse.has(dir)) continue;
      try {
        const s = await stat(dir);
        if (!s.isDirectory() || now - s.mtimeMs < maxAgeMs) continue;
        // Another user's folder in a shared temp folder is theirs to remove.
        if (this.uid !== undefined && s.uid !== this.uid) continue;
      } catch {
        continue;
      }
      await this.remove(dir);
    }
  }

  /** Removes the folders of sessions still running, when the extension stops. */
  removeAll(): void {
    for (const [program, dir] of [...this.running]) {
      this.forget(program);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        this.log(`Cannot remove the debug build ${dir}: ${message(e)}`);
      }
    }
  }

  private forget(program: string): void {
    this.running.delete(program);
    this.sessions.delete(program);
    const timer = this.timers.get(program);
    if (timer) clearTimeout(timer);
    this.timers.delete(program);
  }
}

/** A saved Alan file the compiler can read. */
export interface SavedSource {
  file: string;
  /** Shows the compiler's errors in the Problems panel, or clears them for output without errors. */
  showProblems(stderr: string): void;
}

export interface DebugDeps {
  platform: NodeJS.Platform;
  /** The alan.useWsl setting, on Windows only. */
  useWsl(): boolean;
  /** Saves the active Alan document, through Save As when it has no file. Undefined after telling the user why not. */
  saveActive(): Promise<SavedSource | undefined>;
  /** Saves the Alan document of file. Undefined after telling the user why not. */
  save(file: string): Promise<SavedSource | undefined>;
  /** The compiler, or undefined after offering to install it. */
  findCompiler(): Promise<CompilerRef | undefined>;
  /** Runs the compiler, stopping it when token is cancelled. */
  build(cmd: string, args: string[], cwd: string, token?: vscode.CancellationToken): Promise<RunResult>;
  /** Reports a failed debug build and logs the compiler's output. missing says the compiler was not found. */
  report(detail: string | undefined, missing: boolean, stderr?: string): void;
  showError(message: string): void;
  builds: DebugBuilds;
}

/**
 * The .alan file a program setting names. "${file}" means the active
 * document, "${workspaceFolder}" the folder the configuration belongs to,
 * and a relative path starts from that folder. Any other variable, or a
 * relative path without a folder, gives an error message.
 */
export function programPath(
  program: unknown, folder: string | undefined,
): { active: true } | { file: string } | { error: string } {
  if (typeof program !== "string" || !program.trim()) return { error: NO_PROGRAM };
  const p = program.trim();
  if (p === "${file}") return { active: true };
  if (p.includes("${workspaceFolder}") && folder === undefined) return { error: NO_FOLDER };
  const replaced = folder === undefined ? p : p.split("${workspaceFolder}").join(folder);
  if (replaced.includes("${")) return { error: UNKNOWN_VARIABLE };
  if (path.isAbsolute(replaced)) return { file: path.normalize(replaced) };
  if (folder === undefined) return { error: NO_FOLDER };
  return { file: path.join(folder, replaced) };
}

/** Fields that describe the alan configuration itself. Every other field goes on to CodeLLDB. */
const OWN_FIELDS = new Set(["type", "request", "name", "program"]);

/**
 * Provides the alan debug type. resolveDebugConfiguration saves the file,
 * builds it with -g and returns the CodeLLDB configuration. All of it
 * happens in this first step, because VS Code runs CodeLLDB's own
 * resolvers only when the first step changes the type. Undefined cancels
 * the session quietly.
 */
export class AlanDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  constructor(private readonly deps: DebugDeps) {}

  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    return [{ ...DEFAULT_CONFIG }];
  }

  async resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken,
  ): Promise<vscode.DebugConfiguration | undefined> {
    // Already built. Another resolver must not take the program for an Alan file.
    if (config.type === "lldb") return config;
    const d = this.deps;
    if (d.useWsl()) {
      d.showError(WSL_REFUSAL);
      return undefined;
    }
    // F5 without a launch.json.
    if (!config.type && !config.request && !config.name) config = { ...config, ...DEFAULT_CONFIG };
    const where = programPath(config.program, folder?.uri.fsPath);
    if ("error" in where) {
      d.showError(where.error);
      return undefined;
    }
    const source = "active" in where ? await d.saveActive() : await d.save(where.file);
    if (!source) return undefined;
    const ref = await d.findCompiler();
    if (!ref) return undefined;
    if (ref.wsl) {
      d.showError(WSL_REFUSAL);
      return undefined;
    }
    const passed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) if (!OWN_FIELDS.has(key)) passed[key] = value;
    return this.build(source, ref, passed, token);
  }

  /** Builds source into a new folder. User fields such as args, env, cwd and noDebug win over the defaults. */
  private async build(
    source: SavedSource, ref: CompilerRef, passed: Record<string, unknown>, token?: vscode.CancellationToken,
  ): Promise<vscode.DebugConfiguration | undefined> {
    const d = this.deps;
    const cwd = path.dirname(source.file);
    let dir: string;
    try {
      dir = await d.builds.create();
    } catch (e) {
      d.report(`cannot create a temporary folder: ${message(e)}`, false);
      return undefined;
    }
    let keep = false;
    try {
      const exe = debugProgramPath(dir, source.file, d.platform);
      const cl = commandLine(ref, "build", source.file, { optimize: false, out: exe, debug: true });
      const r = await d.build(cl.cmd, cl.args, cwd, token);
      if (r.failure === "aborted" || token?.isCancellationRequested) return undefined;
      if (r.failure) {
        d.report(r.failure === "timeout" ? "the compiler took too long" : r.detail, r.failure === "missing");
        return undefined;
      }
      if (r.code === 2 && /^usage: alanc/m.test(r.stderr)) {
        d.report(NO_DEBUG_SUPPORT, false, r.stderr);
        return undefined;
      }
      source.showProblems(r.stderr);
      if (r.code !== 0) {
        d.report(failureSummary(r.stderr), false, r.stderr);
        return undefined;
      }
      d.builds.built(exe, dir);
      keep = true;
      const launch = lldbLaunchConfig(exe, cwd, source.file);
      return { ...launch, ...passed, type: launch.type, request: launch.request, name: launch.name, program: exe };
    } catch (e) {
      d.report(message(e), false);
      return undefined;
    } finally {
      if (!keep) await d.builds.remove(dir);
    }
  }
}

/**
 * The provider for the dynamic trigger, with configurations only. VS Code
 * runs the resolvers of every provider registered for a type, whatever its
 * trigger, so this one has none.
 */
export function dynamicProvider(p: AlanDebugConfigurationProvider): vscode.DebugConfigurationProvider {
  return { provideDebugConfigurations: () => p.provideDebugConfigurations() };
}
