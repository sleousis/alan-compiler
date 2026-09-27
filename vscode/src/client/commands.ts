// The Run, Build and Show IR commands, the alan task type, and the
// compiler's diagnostics that go to the language server.
import { statSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import type { Diagnostic } from "vscode-languageserver";
import { checkFile, compilerDiagnostics } from "../server/compilerCheck";
import {
  CompilerRef, buildOutputPath, commandLine, failureSummary, findCompiler, forgetCompiler, needsSaveAs, runCompiler,
  stripAnsi,
} from "./compiler";

const BUILD_TIMEOUT_MS = 120_000;
const IR_TIMEOUT_MS = 60_000;

/**
 * Sends the compiler's diagnostics to the language server, which keeps them
 * until the next notification. So they are cleared as soon as the document
 * changes, and a check still running after a change is stopped.
 */
export class CompilerProblems {
  private readonly shown = new Set<string>();
  private readonly generation = new Map<string, number>();
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly client: LanguageClient, private readonly log: (line: string) => void) {}

  set(doc: vscode.TextDocument, diagnostics: Diagnostic[]): void {
    const key = doc.uri.toString();
    if (diagnostics.length) this.shown.add(key);
    else this.shown.delete(key);
    const uri = this.client.code2ProtocolConverter.asUri(doc.uri);
    this.client.sendNotification("alan/compilerDiagnostics", { uri, diagnostics }).catch(() => {
      // The server is not running. It has no diagnostics to update then.
    });
  }

  changed(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    this.bump(key);
    if (this.shown.has(key)) this.set(doc, []);
  }

  closed(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    this.running.get(key)?.abort();
    this.running.delete(key);
    this.shown.delete(key);
    this.generation.delete(key);
  }

  /** Runs `alanc check` on the saved document and shows the result, unless it changed meanwhile. */
  async check(doc: vscode.TextDocument, ref: CompilerRef): Promise<void> {
    const key = doc.uri.toString();
    const gen = this.bump(key);
    const abort = new AbortController();
    this.running.set(key, abort);
    const version = doc.version;
    try {
      const diagnostics = await checkFile(ref, doc.uri.fsPath, doc.getText(), { signal: abort.signal, log: this.log });
      if (!diagnostics || doc.isClosed || doc.version !== version || this.generation.get(key) !== gen) return;
      this.set(doc, diagnostics);
    } finally {
      if (this.running.get(key) === abort) this.running.delete(key);
    }
  }

  /** Starts a new generation for key and stops the check of the previous one. */
  private bump(key: string): number {
    this.running.get(key)?.abort();
    this.running.delete(key);
    const gen = (this.generation.get(key) ?? 0) + 1;
    this.generation.set(key, gen);
    return gen;
  }
}

export interface Host {
  context: vscode.ExtensionContext;
  problems: CompilerProblems;
  /** The "Alan" output channel. */
  output: vscode.OutputChannel;
}

function existsOnDisk(uri: vscode.Uri): boolean {
  if (uri.scheme !== "file") return false;
  try {
    return statSync(uri.fsPath, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

function optimize(): boolean {
  return vscode.workspace.getConfiguration("alan").get<boolean>("optimize", true);
}

/** Offers to install the compiler. Returns after the user answers. */
export async function offerInstall(): Promise<void> {
  const pick = await vscode.window.showInformationMessage("Alan compiler not found. Install it now?", "Install", "Not now");
  if (pick === "Install") await vscode.commands.executeCommand("alan.install");
}

/**
 * The document for a Uri a command got. An open document whose file was
 * deleted is found among the open ones, since opening its Uri again fails.
 */
async function documentFor(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open;
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch {
    return undefined;
  }
}

/**
 * The document a command works on, saved to a file the compiler can read.
 * An untitled document or one without a file on disk goes through Save As,
 * and undefined means the user cancelled or saving failed.
 */
async function savedDocument(arg: unknown): Promise<vscode.TextDocument | undefined> {
  const doc = arg instanceof vscode.Uri ? await documentFor(arg) : vscode.window.activeTextEditor?.document;
  if (!doc && arg instanceof vscode.Uri) {
    void vscode.window.showWarningMessage(`Cannot open ${arg.fsPath}.`);
    return undefined;
  }
  if (!doc || doc.languageId !== "alan") {
    void vscode.window.showWarningMessage("Open an Alan file first.");
    return undefined;
  }
  if (needsSaveAs({ isUntitled: doc.isUntitled, scheme: doc.uri.scheme, existsOnDisk: existsOnDisk(doc.uri) })) {
    // Save As needs the document in an editor.
    await vscode.window.showTextDocument(doc);
    const saved = await vscode.workspace.saveAs(doc.uri);
    if (!saved || !existsOnDisk(saved)) return undefined;
    return vscode.workspace.openTextDocument(saved);
  }
  if (doc.isDirty && !(await doc.save())) return undefined;
  return existsOnDisk(doc.uri) ? doc : undefined;
}

/** The saved document and the compiler, or undefined after telling the user why not. */
async function prepare(host: Host, arg: unknown): Promise<{ doc: vscode.TextDocument; ref: CompilerRef } | undefined> {
  const doc = await savedDocument(arg);
  if (!doc) return undefined;
  const ref = await findCompiler(host.context);
  if (!ref) {
    void offerInstall();
    return undefined;
  }
  return { doc, ref };
}

/**
 * Reports a compiler that could not start or finish, a path it cannot open,
 * or a failed compile, and logs it with the compiler's output to the Alan
 * output channel.
 */
function reportFailure(host: Host, what: string, detail: string | undefined, missing: boolean, stderr = ""): void {
  host.output.appendLine(`${what} failed: ${missing ? "compiler not found" : detail ?? "no details"}`);
  if (stderr.trim()) host.output.appendLine(stripAnsi(stderr).trimEnd());
  if (missing) {
    forgetCompiler();
    void offerInstall();
    return;
  }
  void vscode.window.showErrorMessage(`${what} failed${detail ? `: ${detail}` : "."}`);
}

/** The folder a program runs in. A \\wsl$ folder is left out: a Windows process cannot start there. */
function runFolder(file: string, ref: CompilerRef): string | undefined {
  const dir = path.dirname(file);
  return ref.wsl && dir.startsWith("\\\\") ? undefined : dir;
}

/** The task that runs file in its own terminal, where the program can read input. */
export function runTask(
  ref: CompilerRef, file: string, scope: vscode.WorkspaceFolder | vscode.TaskScope,
  definition: vscode.TaskDefinition = { type: "alan", file },
): vscode.Task {
  const { cmd, args } = commandLine(ref, "run", file, { optimize: optimize() });
  const task = new vscode.Task(definition, scope, `Run ${path.basename(file)}`, "Alan",
    new vscode.ProcessExecution(cmd, args, { cwd: runFolder(file, ref) }), []);
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    focus: true,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
    showReuseMessage: false,
  };
  return task;
}

function taskScope(uri: vscode.Uri): vscode.WorkspaceFolder | vscode.TaskScope {
  return vscode.workspace.getWorkspaceFolder(uri) ?? vscode.TaskScope.Workspace;
}

/** Listeners for the end of runs still going. Each one leaves when its run ends. */
const runWatchers = new Set<vscode.Disposable>();

async function run(host: Host, arg: unknown): Promise<void> {
  const target = await prepare(host, arg);
  if (!target) return;
  const { doc, ref } = target;
  let task: vscode.Task;
  try {
    task = runTask(ref, doc.uri.fsPath, taskScope(doc.uri));
  } catch (e) {
    return reportFailure(host, "Run", e instanceof Error ? e.message : String(e), false);
  }
  let execution: vscode.TaskExecution;
  try {
    execution = await vscode.tasks.executeTask(task);
  } catch (e) {
    return reportFailure(host, "Run", e instanceof Error ? e.message : String(e), false);
  }
  const ended = vscode.tasks.onDidEndTaskProcess((e) => {
    if (e.execution !== execution) return;
    ended.dispose();
    runWatchers.delete(ended);
    if (e.exitCode === 0) host.problems.set(doc, []);
    else void host.problems.check(doc, ref);
  });
  runWatchers.add(ended);
}

async function build(host: Host, arg: unknown): Promise<void> {
  const target = await prepare(host, arg);
  if (!target) return;
  const { doc, ref } = target;
  const file = doc.uri.fsPath;
  const out = buildOutputPath(file, ref.wsl, process.platform);
  let cl: { cmd: string; args: string[] };
  try {
    cl = commandLine(ref, "build", file, { optimize: optimize(), out });
  } catch (e) {
    return reportFailure(host, "Build", e instanceof Error ? e.message : String(e), false);
  }
  const r = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Building ${path.basename(file)}` },
    () => runCompiler(cl.cmd, cl.args, { timeoutMs: BUILD_TIMEOUT_MS, cwd: runFolder(file, ref) }));
  if (r.failure) return reportFailure(host, "Build", r.failure === "timeout" ? "the compiler took too long" : r.detail, r.failure === "missing");
  host.problems.set(doc, compilerDiagnostics(r.stderr, path.basename(file), doc.getText()));
  if (r.code !== 0) return reportFailure(host, "Build", failureSummary(r.stderr), false, r.stderr);
  const pick = await vscode.window.showInformationMessage(`Built ${out}`, "Reveal");
  if (pick === "Reveal") await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(out));
}

async function showIr(host: Host, arg: unknown): Promise<void> {
  const target = await prepare(host, arg);
  if (!target) return;
  const { doc, ref } = target;
  const file = doc.uri.fsPath;
  let cl: { cmd: string; args: string[] };
  try {
    cl = commandLine(ref, "ir", file, { optimize: optimize() });
  } catch (e) {
    return reportFailure(host, "Show IR", e instanceof Error ? e.message : String(e), false);
  }
  const r = await runCompiler(cl.cmd, cl.args, { timeoutMs: IR_TIMEOUT_MS, cwd: runFolder(file, ref), maxBuffer: 256 * 1024 * 1024 });
  if (r.failure) return reportFailure(host, "Show IR", r.failure === "timeout" ? "the compiler took too long" : r.detail, r.failure === "missing");
  host.problems.set(doc, compilerDiagnostics(r.stderr, path.basename(file), doc.getText()));
  if (r.code !== 0) return reportFailure(host, "Show IR", failureSummary(r.stderr), false, r.stderr);
  let ir: vscode.TextDocument;
  try {
    ir = await vscode.workspace.openTextDocument({ language: "llvm", content: r.stdout });
  } catch {
    // No extension knows the llvm language.
    ir = await vscode.workspace.openTextDocument({ language: "plaintext", content: r.stdout });
  }
  await vscode.window.showTextDocument(ir, { viewColumn: vscode.ViewColumn.Beside, preview: false });
}

/** Provides a Run task for the active Alan file and resolves alan tasks from tasks.json. */
function taskProvider(host: Host): vscode.TaskProvider {
  return {
    async provideTasks() {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc || doc.languageId !== "alan" || !existsOnDisk(doc.uri)) return [];
      const ref = await findCompiler(host.context);
      if (!ref) return [];
      try {
        return [runTask(ref, doc.uri.fsPath, taskScope(doc.uri))];
      } catch {
        return [];
      }
    },
    async resolveTask(task) {
      const file = task.definition.file;
      if (typeof file !== "string" || !file) return undefined;
      const ref = await findCompiler(host.context);
      if (!ref) return undefined;
      const folder = typeof task.scope === "object" ? task.scope : undefined;
      const full = folder && !path.isAbsolute(file) ? path.join(folder.uri.fsPath, file) : file;
      try {
        return runTask(ref, full, task.scope ?? vscode.TaskScope.Workspace, task.definition);
      } catch {
        return undefined;
      }
    },
  };
}

export function registerCommands(host: Host): void {
  const notYet = () => vscode.window.showInformationMessage("Installing the Alan compiler from VS Code is not available yet.");
  host.context.subscriptions.push(
    vscode.commands.registerCommand("alan.run", (arg?: unknown) => run(host, arg)),
    vscode.commands.registerCommand("alan.build", (arg?: unknown) => build(host, arg)),
    vscode.commands.registerCommand("alan.showIr", (arg?: unknown) => showIr(host, arg)),
    vscode.commands.registerCommand("alan.install", notYet),
    vscode.commands.registerCommand("alan.uninstall", notYet),
    vscode.tasks.registerTaskProvider("alan", taskProvider(host)),
    { dispose: () => { for (const w of runWatchers) w.dispose(); runWatchers.clear(); } },
  );
}
