// Activates the extension: starts the language server, registers the
// commands and the alan task type, checks saved files with the compiler,
// and offers to install the compiler when it is missing.
import * as path from "node:path";
import * as vscode from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from "vscode-languageclient/node";
import { CompilerProblems, offerInstall, registerCommands } from "./commands";
import { findCompiler, forgetCompiler } from "./compiler";

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const module = context.asAbsolutePath(path.join("dist", "server.js"));
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    debug: { module, transport: TransportKind.ipc, options: { execArgv: ["--nolazy", "--inspect=6009"] } },
  };
  const clientOptions: LanguageClientOptions = { documentSelector: [{ language: "alan" }] };
  client = new LanguageClient("alan", "Alan", serverOptions, clientOptions);

  const problems = new CompilerProblems(client);
  registerCommands({ context, problems });

  let offered = false;
  const offerOnce = async (doc: vscode.TextDocument) => {
    if (offered || doc.languageId !== "alan") return;
    offered = true;
    if (!(await findCompiler(context))) await offerInstall();
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => void offerOnce(doc)),
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
  for (const doc of vscode.workspace.textDocuments) void offerOnce(doc);

  await client.start();
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
