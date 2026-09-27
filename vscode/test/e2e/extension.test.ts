// End-to-end tests: the packaged extension in a real VS Code, talking to its
// language server through the editor's own provider commands.
import { strict as assert } from "assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

const examples = path.resolve(__dirname, "../../../Examples");
const repo = path.resolve(__dirname, "../../..");
/** A file of the compiler's tests, with LF line ends. */
const testFile = (name: string) => fs.readFileSync(path.join(repo, "tests", name), "utf8").replace(/\r\n/g, "\n");
const bubbleSort = path.join(examples, "BubbleSort.alan");

/** Calls `probe` until it returns a value, or fails after `ms`. */
async function eventually<T>(what: string, ms: number, probe: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function completionItems(uri: vscode.Uri, pos: vscode.Position): Promise<vscode.CompletionItem[]> {
  const list = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", uri, pos);
  return list.items;
}

const labelOf = (i: vscode.CompletionItem) => (typeof i.label === "string" ? i.label : i.label.label);

/**
 * The language server's completion item for a library function, if it answered.
 * VS Code also offers the words of the file as plain text items, so only a
 * function item with the signature as detail counts.
 */
async function libraryItem(uri: vscode.Uri, name: string): Promise<vscode.CompletionItem | undefined> {
  // Line 50 of BubbleSort.alan, `i = 0;` in the main block.
  const items = await completionItems(uri, new vscode.Position(49, 1));
  return items.find((i) => labelOf(i) === name && i.kind === vscode.CompletionItemKind.Function && i.detail?.startsWith(`${name} (`));
}

function hoverAt(doc: vscode.TextDocument, pos: vscode.Position): Thenable<vscode.Hover[]> {
  return vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", doc.uri, pos);
}

function hoverText(hovers: vscode.Hover[]): string {
  return hovers.flatMap((h) => h.contents.map((c) => (typeof c === "string" ? c : c.value))).join("\n");
}

/** An unsaved copy of some Alan text, so the tests never change a file on disk. */
async function scratch(content: string): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument({ language: "alan", content });
  await vscode.window.showTextDocument(doc);
  return doc;
}

describe("Alan extension", function () {
  let doc: vscode.TextDocument;

  before(async function () {
    this.timeout(120_000);
    const ext = vscode.extensions.getExtension("sleousis.alan");
    assert.ok(ext, "the extension is installed in the test instance");
    doc = await vscode.workspace.openTextDocument(bubbleSort);
    await vscode.window.showTextDocument(doc);
    await ext.activate();
    // The language server starts when the first Alan document opens. It is
    // ready once it offers a library function the file does not mention.
    await eventually("the language server", 60_000, () => libraryItem(doc.uri, "readInteger"));
  });

  it("offers library functions inside the main block", async () => {
    // strlen appears nowhere in BubbleSort.alan, so only the server can offer it.
    for (const name of ["writeInteger", "strlen"]) {
      const item = await libraryItem(doc.uri, name);
      assert.ok(item, `the server offers ${name}`);
    }
  });

  it("hovers a call with the function's signature", async () => {
    // Line 57, `bsort(16, x);`.
    const hovers = await hoverAt(doc, new vscode.Position(56, 2));
    assert.match(hoverText(hovers), /bsort \(n : int, x : reference int\[\]\) : proc/);
  });

  it("reports a syntax error within 2 seconds of typing it", async () => {
    // The copy starts with an error, so its diagnostics show that the server
    // analysed it. Zero diagnostics before any analysis would prove nothing.
    const error = "x = ;\n\t";
    const lines = fs.readFileSync(bubbleSort, "utf8").split("\n");
    lines[48] = lines[48].slice(0, 1) + error + lines[48].slice(1);
    const copy = await scratch(lines.join("\n"));
    const count = () => vscode.languages.getDiagnostics(copy.uri).length;
    await eventually("the first analysis of the copy", 10_000, async () => (count() ? true : undefined));
    const fix = new vscode.WorkspaceEdit();
    fix.delete(copy.uri, new vscode.Range(new vscode.Position(48, 1), new vscode.Position(49, 1)));
    assert.ok(await vscode.workspace.applyEdit(fix));
    assert.equal(copy.getText(), fs.readFileSync(bubbleSort, "utf8"));
    // Only a new analysis clears them: the fixed copy has no problems.
    await eventually("the fixed copy to have no problems", 10_000, async () => (count() === 0 ? true : undefined));
    const edit = new vscode.WorkspaceEdit();
    edit.insert(copy.uri, new vscode.Position(48, 1), error);
    const typed = Date.now();
    assert.ok(await vscode.workspace.applyEdit(edit));
    await eventually("a diagnostic", 2_000, async () => {
      const diags = vscode.languages.getDiagnostics(copy.uri);
      return diags.length ? diags : undefined;
    });
    assert.ok(Date.now() - typed <= 2_000);
  });

  it("reports the compiler's message on the compiler's line", async () => {
    const copy = await scratch("main () : proc\n  p () : proc { }\n{\n  if (p() == p()) ;\n}\n");
    const diags = await eventually("a diagnostic", 10_000, async () => {
      const d = vscode.languages.getDiagnostics(copy.uri);
      return d.length ? d : undefined;
    });
    assert.deepEqual(diags.map((d) => [d.range.start.line, d.message]),
      [[3, "type mismatch in == operator (operands must be int or byte, not proc)."]]);
  });

  /** The diagnostics of an unsaved copy of text, once the server has analysed it. */
  async function diagnosticsOf(text: string): Promise<[number, string][]> {
    const copy = await scratch(text);
    const diags = await eventually("a diagnostic", 20_000, async () => {
      const d = vscode.languages.getDiagnostics(copy.uri);
      return d.length ? d : undefined;
    });
    return diags.map((d) => [d.range.start.line, d.message]);
  }

  for (const kind of ["ifs", "expression"]) {
    it(`follows 3000 nested ${kind} and reports 3001, as the compiler does`, async function () {
      this.timeout(60_000);
      // An unknown name after the nesting shows that the server got through it.
      const ok = testFile(`regress/nesting_3000_${kind}.alan`).replace(/\}\s*$/, "  unknown = 1;\n}\n");
      const last = ok.split("\n").length - 3;
      assert.deepEqual(await diagnosticsOf(ok), [[last, "Identifier unknown not found."]]);
      const expected = JSON.parse(testFile("errors/expected.json")) as { file: string; line: number }[];
      const line = expected.find((e) => e.file === `tests/errors/nesting_3001_${kind}.alan`)!.line;
      assert.deepEqual(await diagnosticsOf(testFile(`errors/nesting_3001_${kind}.alan`)), [[line - 1, "Nesting is too deep"]]);
    });
  }

  it("outlines, completes and hovers in 3000 nested functions", async function () {
    this.timeout(60_000);
    const text = `main () : proc\n${"  g () : proc\n".repeat(3000)}${"  { }\n".repeat(3001)}`;
    const copy = await scratch(text);
    const symbols = await eventually("the outline", 20_000, async () => {
      const s = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", copy.uri);
      return s?.length ? s : undefined;
    });
    // The outline nests 100 functions deep and lists the rest flat.
    let depth = 1;
    let s = symbols[0];
    while (s.children.length === 1) { s = s.children[0]; depth++; }
    assert.equal(depth + s.children.length, 3001);
    const items = await completionItems(copy.uri, new vscode.Position(3001, 3));
    assert.ok(items.some((i) => labelOf(i) === "g" && i.kind === vscode.CompletionItemKind.Function));
    assert.match(hoverText(await hoverAt(copy, new vscode.Position(3000, 2))), /g \(\) : proc/);
  });

  it("formats a messy program like the formatter's unit test", async () => {
    const messy = await scratch("main():proc\nx:int;\n{x=1+2*3;if(x>3)writeInteger(x);else{x=0;}}\n");
    const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      "vscode.executeFormatDocumentProvider", messy.uri, { tabSize: 4, insertSpaces: true });
    assert.ok(edits?.length, "the formatter answered with edits");
    const apply = new vscode.WorkspaceEdit();
    apply.set(messy.uri, edits);
    assert.ok(await vscode.workspace.applyEdit(apply));
    assert.equal(messy.getText(), [
      "main () : proc",
      "    x : int;",
      "{",
      "    x = 1 + 2 * 3;",
      "    if (x > 3)",
      "        writeInteger(x);",
      "    else {",
      "        x = 0;",
      "    }",
      "}", ""].join("\n"));
  });

  it("renames a local variable at every use", async () => {
    // `seed` in main: its declaration and four uses on lines 49, 52 and 53.
    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
      "vscode.executeDocumentRenameProvider", doc.uri, new vscode.Position(48, 2), "s");
    const edits = edit.get(doc.uri);
    assert.equal(edits.length, 5);
    assert.ok(edits.every((e) => doc.getText(e.range) === "seed"));
  });
});
