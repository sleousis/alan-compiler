// Activates the extension: registers the commands and the alan task type,
// starts the language server once an Alan document is open, checks saved
// files with the compiler, and offers to install the compiler when it is
// missing or to update an installed copy that is too old.
import * as path from "node:path";
import * as vscode from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from "vscode-languageclient/node";
import { CompilerProblems, offerInstall, registerCommands } from "./commands";
import { findCompiler, forgetCompiler } from "./compiler";
import { installedTag, isOlderTag, MIN_COMPILER } from "./installer";

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
  registerCommands({ context, problems, output });

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
    if (!(await findCompiler(context))) await offerInstall();
  };

  context.subscriptions.push(
    output,
    vscode.workspace.onDidOpenTextDocument((doc) => void alanOpened(doc)),
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (doc.languageId !== "alan" || doc.uri.scheme !== "file") return;
      if (!vscode.workspace.getConfiguration("alan").get<boolean>("checkOnSave", true)) return;
      const ref = await findCompiler(context);
      if (ref) await problems.check(doc, ref);
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
  void offerUpdate(context);
}

/** Offers to update the installed compiler when it is older than MIN_COMPILER and in use. */
async function offerUpdate(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("alan");
  if (cfg.get<string>("compilerPath", "").trim()) return;
  if (process.platform === "win32" && cfg.get<boolean>("useWsl", false)) return;
  const tag = installedTag(context.globalStorageUri.fsPath);
  if (!tag || !isOlderTag(tag, MIN_COMPILER)) return;
  const pick = await vscode.window.showInformationMessage(
    `The installed Alan compiler ${tag} is older than ${MIN_COMPILER}, which this extension needs. Update it now?`,
    "Update", "Not now");
  if (pick === "Update") await vscode.commands.executeCommand("alan.install");
}

export async function deactivate(): Promise<void> {
  if (client && started) {
    await started;
    if (client.isRunning()) await client.stop();
  }
}
