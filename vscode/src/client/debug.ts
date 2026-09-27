// F5 debugging. The alan debug type builds the file with `alanc build -g`
// into a temporary folder and hands the program to CodeLLDB as an lldb
// launch configuration. The folder goes away when the debug session ends.
// Everything that talks to VS Code comes in through DebugDeps, so the unit
// tests run this file without VS Code.
import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import { CompilerRef, RunResult, buildOutputPath, commandLine, failureSummary } from "./compiler";

export const WSL_REFUSAL = "Debugging needs the native compiler. Turn off alan.useWsl or use a Remote WSL window.";
export const NO_PROGRAM = 'Set "program" in the launch configuration to the .alan file to debug.';
export const NO_DEBUG_SUPPORT =
  "This Alan compiler cannot build for debugging. Update it with Alan: Install or Update Compiler.";

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

/** Temporary folders of debug builds, each kept while its session runs. */
export class DebugBuilds {
  /** Program path to the folder it lives in. */
  private readonly running = new Map<string, string>();

  constructor(private readonly root: string = os.tmpdir()) {}

  /** A new empty folder for one build. */
  create(): Promise<string> {
    return mkdtemp(path.join(this.root, "alan-debug-"));
  }

  /** Keeps dir until the session that runs program ends. */
  started(program: string, dir: string): void {
    this.running.set(program, dir);
  }

  /** Removes the folder of the session that ran program. Other programs are left alone. */
  async ended(program: unknown): Promise<void> {
    if (typeof program !== "string") return;
    const dir = this.running.get(program);
    if (!dir) return;
    this.running.delete(program);
    await this.remove(dir);
  }

  /**
   * Removes dir with everything in it, the macOS <program>.o too. Windows may
   * hold the program for a moment after it exits, so removal retries.
   */
  async remove(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {
      // Left for the system's temporary file cleanup.
    });
  }

  /** Removes the folders of sessions still running, when the extension stops. */
  removeAll(): void {
    for (const dir of this.running.values()) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Left for the system's temporary file cleanup.
      }
    }
    this.running.clear();
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
 * Provides the alan debug type. The first step turns F5 without a
 * launch.json into DEFAULT_CONFIG and saves the active file, which may need
 * Save As. The second step builds the file and returns the CodeLLDB
 * configuration. Undefined cancels the session quietly.
 */
export class AlanDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  constructor(private readonly deps: DebugDeps) {}

  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    return [{ ...DEFAULT_CONFIG }];
  }

  async resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined> {
    if (this.deps.useWsl()) {
      this.deps.showError(WSL_REFUSAL);
      return undefined;
    }
    if (!config.type && !config.request && !config.name) config = { ...DEFAULT_CONFIG, noDebug: config.noDebug };
    // VS Code cannot put an untitled document's path in ${file}, so the
    // active document is saved here, before the variables are replaced.
    if (config.program === "${file}") {
      const saved = await this.deps.saveActive();
      if (!saved) return undefined;
      config = { ...config, program: saved.file };
    }
    return config;
  }

  async resolveDebugConfigurationWithSubstitutedVariables(
    folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken,
  ): Promise<vscode.DebugConfiguration | undefined> {
    const d = this.deps;
    if (d.useWsl()) {
      d.showError(WSL_REFUSAL);
      return undefined;
    }
    let source: SavedSource | undefined;
    if (!config.type && !config.program) {
      source = await d.saveActive();
    } else if (typeof config.program === "string" && config.program.trim()) {
      const program = config.program.trim();
      const full = folder && !path.isAbsolute(program) ? path.join(folder.uri.fsPath, program) : program;
      source = await d.save(path.resolve(full));
    } else {
      d.showError(NO_PROGRAM);
      return undefined;
    }
    if (!source) return undefined;
    const ref = await d.findCompiler();
    if (!ref) return undefined;
    if (ref.wsl) {
      d.showError(WSL_REFUSAL);
      return undefined;
    }
    return this.build(source, ref, config.noDebug === true, token);
  }

  private async build(
    source: SavedSource, ref: CompilerRef, noDebug: boolean, token?: vscode.CancellationToken,
  ): Promise<vscode.DebugConfiguration | undefined> {
    const d = this.deps;
    const cwd = path.dirname(source.file);
    let dir: string;
    try {
      dir = await d.builds.create();
    } catch (e) {
      d.report(`cannot create a temporary folder: ${e instanceof Error ? e.message : String(e)}`, false);
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
      d.builds.started(exe, dir);
      keep = true;
      const launch = lldbLaunchConfig(exe, cwd, source.file);
      if (noDebug) launch.noDebug = true;
      return launch;
    } catch (e) {
      d.report(e instanceof Error ? e.message : String(e), false);
      return undefined;
    } finally {
      if (!keep) await d.builds.remove(dir);
    }
  }
}
