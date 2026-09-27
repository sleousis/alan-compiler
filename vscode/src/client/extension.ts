// Activates the extension: registers the commands, the alan task type and
// the alan debug type, starts the language server once an Alan document is
// open, checks saved files with the compiler, and offers to install the
// compiler when it is missing or to update one that is too old.
import * as path from "node:path";
import * as vscode from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from "vscode-languageclient/node";
import { compilerDiagnostics } from "../server/compilerCheck";
import { CompilerProblems, Host, offerInstall, registerCommands, reportFailure, savedDocument, useWsl } from "./commands";
import { CompilerRef, compilerVersion, findCompiler, forgetCompiler, runCompiler } from "./compiler";
import { AlanDebugConfigurationProvider, DebugBuilds, DebugDeps, SavedSource, dynamicProvider } from "./debug";
import { installedCompilerPath, MIN_COMPILER } from "./installer";

let client: LanguageClient | undefined;
let started: Promise<void> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Alan", { log: true });
  const module = context.asAbsolutePath(path.join("dist", "server.js"));
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    debug: { module, transport: TransportKind.ipc, options: { execArgv: ["--nolazy", "--inspect=6009"] } },
  };
  const clientOptions: LanguageClientOptions = { documentSelector: [{ language: "alan" }], outputChannel: output };
  const lc = new LanguageClient("alan", "Alan", serverOptions, clientOptions);
  client = lc;

  const problems = new CompilerProblems(lc, (line) => output.appendLine(line));
  const host: Host = { context, problems, output };
  registerCommands(host);
  registerDebugging(host);

  // The task service activates the extension for the alan task type in any
  // workspace, so the server starts only when an Alan document shows up.
  let offered = false;
  const alanOpened = async (doc: vscode.TextDocument) => {
    if (doc.languageId !== "alan") return;
    started ??= lc.start().catch((e) => {
      output.appendLine(`The Alan language server did not start: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (offered) return;
    offered = true;
    const ref = await findCompiler(context);
    if (ref) await offerUpdate(context, ref);
    else await offerInstall();
  };

  context.subscriptions.push(
    output,
    vscode.workspace.onDidOpenTextDocument((doc) => void alanOpened(doc)),
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (doc.languageId !== "alan" || doc.uri.scheme !== "file") return;
      if (!vscode.workspace.getConfiguration("alan").get<boolean>("checkOnSave", true)) return;
      const ref = await findCompiler(context);
      if (!ref) return;
      void offerUpdate(context, ref);
      await problems.check(doc, ref);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId === "alan" && e.contentChanges.length) problems.changed(e.document);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => problems.closed(doc)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("alan")) forgetCompiler();
    }),
  );
  for (const doc of vscode.workspace.textDocuments) void alanOpened(doc);
}

/** A debug build may link the C library for debugging first, which takes a while once. */
const DEBUG_BUILD_TIMEOUT_MS = 600_000;

function sameFile(a: string, b: string): boolean {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === "win32" || process.platform === "darwin" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function savedSource(host: Host, doc: vscode.TextDocument): SavedSource {
  return {
    file: doc.uri.fsPath,
    showProblems: (stderr) => host.problems.set(doc, compilerDiagnostics(stderr, path.basename(doc.uri.fsPath), doc.getText())),
  };
}

/**
 * Registers the alan debug type. Each debug build goes when its session
 * ends or never starts, and builds left by an earlier VS Code go now.
 */
function registerDebugging(host: Host): void {
  const builds = new DebugBuilds(undefined, (line) => host.output.appendLine(line));
  void builds.sweep();
  const deps: DebugDeps = {
    platform: process.platform,
    useWsl,
    saveActive: async () => {
      const doc = await savedDocument(undefined);
      return doc && savedSource(host, doc);
    },
    save: async (file) => {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && sameFile(d.uri.fsPath, file));
      const doc = await savedDocument(open?.uri ?? vscode.Uri.file(file));
      return doc && savedSource(host, doc);
    },
    findCompiler: async () => {
      const ref = await findCompiler(host.context);
      if (!ref) void offerInstall();
      return ref;
    },
    build: async (cmd, args, cwd, token) => vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Building for debugging", cancellable: true },
      (_progress, cancel) => {
        const abort = new AbortController();
        const stops = [cancel.onCancellationRequested(() => abort.abort())];
        if (token) stops.push(token.onCancellationRequested(() => abort.abort()));
        return runCompiler(cmd, args, { timeoutMs: DEBUG_BUILD_TIMEOUT_MS, cwd, signal: abort.signal })
          .finally(() => stops.forEach((s) => s.dispose()));
      }),
    report: (detail, missing, stderr) => reportFailure(host, "Debug build", detail, missing, stderr),
    showError: (message) => void vscode.window.showErrorMessage(message),
    builds,
  };
  const provider = new AlanDebugConfigurationProvider(deps);
  host.context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider("alan", provider),
    vscode.debug.registerDebugConfigurationProvider("alan", dynamicProvider(provider),
      vscode.DebugConfigurationProviderTriggerKind.Dynamic),
    vscode.debug.onDidStartDebugSession((session) => {
      if (session.type === "lldb") builds.started(session.configuration.program);
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (session.type === "lldb") void builds.ended(session.configuration.program);
    }),
    { dispose: () => builds.removeAll() },
  );
}

/** Compilers already found too old, by path and answer, so each is mentioned once. */
const warned = new Set<string>();

/**
 * Offers to update the compiler in use when `alanc --version` shows it is
 * older than MIN_COMPILER, or it has no --version (before 2.0). A compiler
 * the alan.compilerPath setting names gets a pointer to the setting, as an
 * install does not replace it.
 */
async function offerUpdate(context: vscode.ExtensionContext, ref: CompilerRef): Promise<void> {
  const check = await compilerVersion(ref);
  if (check.status !== "old") return;
  const key = `${ref.wsl ? "wsl:" : ""}${ref.exe} ${check.version ?? ""}`;
  if (warned.has(key)) return;
  warned.add(key);
  const installed = !ref.wsl && ref.exe === installedCompilerPath(context.globalStorageUri.fsPath, process.platform);
  const who = installed ? "The installed Alan compiler" : `The Alan compiler at ${ref.exe}`;
  const what = `${who} is ${check.version ?? "from before 2.0"} and this extension needs ${MIN_COMPILER} or later.`;
  if (vscode.workspace.getConfiguration("alan").get<string>("compilerPath", "").trim()) {
    const pick = await vscode.window.showWarningMessage(
      `${what} It comes from the alan.compilerPath setting. Point the setting at a newer compiler, or clear it and install the latest.`,
      "Open Settings");
    if (pick === "Open Settings") await vscode.commands.executeCommand("workbench.action.openSettings", "alan.compilerPath");
    return;
  }
  const pick = await vscode.window.showInformationMessage(`${what} Install the latest now?`, "Update", "Not now");
  if (pick === "Update") await vscode.commands.executeCommand("alan.install");
}

export async function deactivate(): Promise<void> {
  if (client && started) {
    await started;
    if (client.isRunning()) await client.stop();
  }
}
