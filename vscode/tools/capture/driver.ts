// A throwaway extension that tools/capture-screenshots.mjs installs, next to
// the packaged Alan extension, in the fresh VS Code it starts. It drives the
// Alan extension through VS Code's own commands, has tools/capture-window.ps1
// photograph the window, and quits VS Code when done. It is installed rather
// than loaded as a development extension, so the window title does not say
// "Extension Development Host".
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

interface Config {
  /** tools/capture-window.ps1 */
  script: string;
  /** The workspace folder with BubbleSort.alan and HelloWorld.alan. */
  demo: string;
  /** Where editor.png and editor-hover.png go. */
  shots: string;
  /** Where the frames of the Run recording go. */
  frames: string;
  /** Gets "ok" or the error when the driver is done. */
  result: string;
  width: number;
  height: number;
}

const cfg: Config = JSON.parse(process.env.ALAN_CAPTURE_CONFIG ?? "{}");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ps(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", cfg.script,
      "-ExtHostPid", String(process.pid), "-Width", String(cfg.width), "-Height", String(cfg.height), ...args],
    (err, _out, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve()));
  });
}

async function eventually<T>(what: string, ms: number, probe: () => Promise<T | undefined> | T | undefined): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(200);
  }
}

/** The position just after `prefix` at the start of `needle` on the line that has it. */
function find(doc: vscode.TextDocument, needle: string, prefix = ""): vscode.Position {
  for (let line = 0; line < doc.lineCount; line++) {
    const col = doc.lineAt(line).text.indexOf(needle);
    if (col >= 0) return new vscode.Position(line, col + prefix.length);
  }
  throw new Error(`${needle} is not in ${doc.fileName}.`);
}

async function tidyWorkbench(): Promise<void> {
  for (const cmd of ["notifications.clearAll", "workbench.action.closeAuxiliaryBar", "workbench.action.closePanel"]) {
    await vscode.commands.executeCommand(cmd).then(undefined, () => undefined);
  }
}

async function activateAlan(): Promise<void> {
  const ext = vscode.extensions.getExtension("sleousis.alan");
  if (!ext) throw new Error("The Alan extension is not installed.");
  await ext.activate();
}

async function editorShots(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  const doc = await vscode.workspace.openTextDocument(path.join(cfg.demo, "BubbleSort.alan"));
  const editor = await vscode.window.showTextDocument(doc);
  await activateAlan();

  // The language server is ready once it offers a library function and has
  // reported the deliberate error in the file.
  await eventually("library completion", 60_000, async () => {
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider", doc.uri, find(doc, "writeInteger(x[i])", "write"));
    return list.items.some((i) => (typeof i.label === "string" ? i.label : i.label.label) === "writeChar") ? true : undefined;
  });
  await eventually("the live error", 30_000, () => (vscode.languages.getDiagnostics(doc.uri).length ? true : undefined));
  await tidyWorkbench();

  // Show the writeArray procedure and the main block, and complete "write".
  const top = find(doc, "writeArray (msg").line;
  editor.revealRange(new vscode.Range(top, 0, top, 0), vscode.TextEditorRevealType.AtTop);
  const at = find(doc, "writeInteger(x[i])", "write");
  editor.selection = new vscode.Selection(at, at);
  await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  await sleep(500);
  await vscode.commands.executeCommand("editor.action.triggerSuggest");
  await sleep(1500);
  // Move to writeInteger, a library function, and open its details.
  for (let i = 0; i < 3; i++) {
    await vscode.commands.executeCommand("selectNextSuggestion");
    await sleep(150);
  }
  await vscode.commands.executeCommand("toggleSuggestionDetails");
  await sleep(1500);
  await vscode.commands.executeCommand("notifications.clearAll");
  await sleep(300);
  await ps(["-Out", path.join(cfg.shots, "editor.png")]);

  // The same view with the error's hover instead of the completion list.
  await vscode.commands.executeCommand("hideSuggestWidget");
  const bad = vscode.languages.getDiagnostics(doc.uri)[0].range.start.translate(0, 2);
  editor.selection = new vscode.Selection(bad, bad);
  await sleep(500);
  await vscode.commands.executeCommand("editor.action.showHover");
  await sleep(1500);
  await vscode.commands.executeCommand("notifications.clearAll");
  await sleep(300);
  await ps(["-Out", path.join(cfg.shots, "editor-hover.png")]);
}

async function runRecording(): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(path.join(cfg.demo, "HelloWorld.alan"));
  const editor = await vscode.window.showTextDocument(doc);
  editor.selection = new vscode.Selection(0, 0, 0, 0);
  await activateAlan();
  await sleep(3000);
  await tidyWorkbench();
  await sleep(500);

  const recording = ps(["-FramesDir", cfg.frames, "-DurationMs", "3600", "-IntervalMs", "120"]);
  await eventually("the recorder", 30_000, () => (fs.existsSync(path.join(cfg.frames, "ready")) ? true : undefined));
  await sleep(700);
  // What the Run button in the editor title runs.
  await vscode.commands.executeCommand("alan.run");
  await recording;
}

async function drive(): Promise<void> {
  fs.mkdirSync(cfg.shots, { recursive: true });
  await ps(["-Setup"]);
  await sleep(1500);
  // The Run first, while only HelloWorld.alan is open, so the Problems badge
  // does not show BubbleSort's deliberate error.
  await runRecording();
  await editorShots();
}

export function activate(): void {
  if (!cfg.result) return;
  void drive().then(
    () => fs.writeFileSync(cfg.result, "ok"),
    (e: unknown) => fs.writeFileSync(cfg.result, e instanceof Error ? e.stack ?? e.message : String(e)),
  ).finally(() => vscode.commands.executeCommand("workbench.action.quit"));
}
