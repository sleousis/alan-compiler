// Entry point of the language server. It creates the LSP connection and
// registers the features of features.ts. It keeps the last analysis of a
// clean text per document, so completion still works while the current text
// has a syntax error.
import {
  CompletionItem, CompletionItemKind, Diagnostic, DiagnosticSeverity, DocumentHighlight, DocumentSymbol, LSPErrorCodes,
  Location, MarkupKind, ProposedFeatures, ResponseError, SymbolKind, TextDocumentSyncKind, TextDocuments, TextEdit,
  WorkspaceEdit, createConnection,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  CompletionEntry, OutlineSymbol, analyzeSource, completions, computeDiagnostics, definition, documentSymbols,
  formatDocument, formatRange, hover, mergeDiagnostics, prepareRename, references, rename, signatureHelp,
} from "./features";
import { Analysis } from "./scopes";

const DEBOUNCE_MS = 150;

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

interface DocState {
  live: Diagnostic[];
  /** Diagnostics the client got from the compiler, through alan/compilerDiagnostics. */
  compiler: Diagnostic[];
  lastGood?: Analysis;
  timer?: ReturnType<typeof setTimeout>;
}
const states = new Map<string, DocState>();

/**
 * Runs a handler body. An exception in the analysis fails only this request
 * or refresh: it is logged and the fallback value is returned.
 */
function guard<T>(what: string, fallback: T, body: () => T): T {
  try {
    return body();
  } catch (e) {
    connection.console.error(`${what} failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    return fallback;
  }
}

function state(uri: string): DocState {
  let s = states.get(uri);
  if (!s) {
    s = { live: [], compiler: [] };
    states.set(uri, s);
  }
  return s;
}

function publish(uri: string) {
  const s = state(uri);
  connection.sendDiagnostics({ uri, diagnostics: mergeDiagnostics(s.live, s.compiler) });
}

function refresh(doc: TextDocument) {
  const s = state(doc.uri);
  const source = analyzeSource(doc.getText());
  if (source.clean && source.analysis) s.lastGood = source.analysis;
  s.live = computeDiagnostics(source).map((d) => {
    const out: Diagnostic = {
      range: d.range,
      message: d.message,
      severity: d.severity === "error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
      source: d.source,
    };
    if (d.code) out.code = d.code;
    return out;
  });
  publish(doc.uri);
}

function schedule(doc: TextDocument) {
  const s = state(doc.uri);
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = undefined;
    const current = documents.get(doc.uri);
    // On failure the previous diagnostics stay.
    if (current) guard("Analysis", undefined, () => refresh(current));
  }, DEBOUNCE_MS);
}

connection.onInitialize(() => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    completionProvider: {},
    hoverProvider: true,
    signatureHelpProvider: { triggerCharacters: ["(", ","] },
    definitionProvider: true,
    documentSymbolProvider: true,
    documentFormattingProvider: true,
    documentRangeFormattingProvider: true,
    referencesProvider: true,
    documentHighlightProvider: true,
    renameProvider: { prepareProvider: true },
  },
}));

documents.onDidChangeContent((e) => schedule(e.document));

documents.onDidClose((e) => {
  const s = states.get(e.document.uri);
  if (s?.timer) clearTimeout(s.timer);
  states.delete(e.document.uri);
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

connection.onNotification("alan/compilerDiagnostics", (p: { uri: string; diagnostics: Diagnostic[] }) => {
  if (!documents.get(p.uri)) return;
  state(p.uri).compiler = p.diagnostics;
  publish(p.uri);
});

const COMPLETION_KINDS: Record<CompletionEntry["kind"], CompletionItemKind> = {
  keyword: CompletionItemKind.Keyword,
  function: CompletionItemKind.Function,
  variable: CompletionItemKind.Variable,
  parameter: CompletionItemKind.Variable,
  library: CompletionItemKind.Function,
  snippet: CompletionItemKind.Snippet,
};

connection.onCompletion((p): CompletionItem[] => guard("Completion", [], () => {
  const doc = documents.get(p.textDocument.uri);
  if (!doc) return [];
  return completions(doc.getText(), p.position, states.get(doc.uri)?.lastGood).map((c) => {
    const item: CompletionItem = { label: c.label, kind: COMPLETION_KINDS[c.kind] };
    if (c.detail) item.detail = c.detail;
    if (c.documentation) item.documentation = c.documentation;
    if (c.insertText) item.insertText = c.insertText;
    return item;
  });
}));

connection.onHover((p) => guard("Hover", null, () => {
  const doc = documents.get(p.textDocument.uri);
  const text = doc && hover(doc.getText(), p.position);
  return text ? { contents: { kind: MarkupKind.Markdown, value: text } } : null;
}));

connection.onSignatureHelp((p) => guard("Signature help", null, () => {
  const doc = documents.get(p.textDocument.uri);
  const s = doc && signatureHelp(doc.getText(), p.position, states.get(doc.uri)?.lastGood);
  if (!s) return null;
  return {
    signatures: [{
      label: s.label,
      documentation: s.documentation,
      parameters: s.parameters.map((label) => ({ label })),
    }],
    activeSignature: 0,
    activeParameter: s.activeParameter,
  };
}));

connection.onDefinition((p) => guard("Definition", null, () => {
  const doc = documents.get(p.textDocument.uri);
  const range = doc && definition(doc.getText(), p.position);
  return range ? { uri: p.textDocument.uri, range } : null;
}));

function toDocumentSymbol(s: OutlineSymbol): DocumentSymbol {
  return {
    name: s.name,
    kind: s.kind === "function" ? SymbolKind.Function : SymbolKind.Variable,
    range: s.range,
    selectionRange: s.selectionRange,
    children: s.children.map(toDocumentSymbol),
  };
}

connection.onDocumentSymbol((p) => guard("Outline", [], () => {
  const doc = documents.get(p.textDocument.uri);
  return doc ? documentSymbols(doc.getText()).map(toDocumentSymbol) : [];
}));

connection.onDocumentFormatting((p): TextEdit[] => guard("Formatting", [], () => {
  const doc = documents.get(p.textDocument.uri);
  const text = doc?.getText();
  const formatted = text === undefined ? undefined : formatDocument(text, p.options);
  if (!doc || formatted === undefined || formatted === text) return [];
  return [TextEdit.replace({ start: { line: 0, character: 0 }, end: doc.positionAt(text!.length) }, formatted)];
}));

connection.onDocumentRangeFormatting((p): TextEdit[] => guard("Range formatting", [], () => {
  const doc = documents.get(p.textDocument.uri);
  const edit = doc && formatRange(doc.getText(), p.range, p.options);
  return edit ? [TextEdit.replace(edit.range, edit.newText)] : [];
}));

connection.onReferences((p): Location[] => guard("References", [], () => {
  const doc = documents.get(p.textDocument.uri);
  if (!doc) return [];
  return references(doc.getText(), p.position, p.context.includeDeclaration).map((range) => ({ uri: doc.uri, range }));
}));

connection.onDocumentHighlight((p): DocumentHighlight[] => guard("Highlights", [], () => {
  const doc = documents.get(p.textDocument.uri);
  return doc ? references(doc.getText(), p.position, true).map((range) => ({ range })) : [];
}));

// A refused rename answers with an error, which the editor shows as the reason.
connection.onPrepareRename((p) => guard("Prepare rename", null, () => {
  const doc = documents.get(p.textDocument.uri);
  if (!doc) return null;
  const r = prepareRename(doc.getText(), p.position);
  if ("error" in r) return new ResponseError(LSPErrorCodes.RequestFailed, r.error);
  return r;
}));

connection.onRenameRequest((p) => guard<WorkspaceEdit | ResponseError | null>("Rename", null, () => {
  const doc = documents.get(p.textDocument.uri);
  if (!doc) return null;
  const r = rename(doc.getText(), p.position, p.newName);
  if ("error" in r) return new ResponseError(LSPErrorCodes.RequestFailed, r.error);
  return { changes: { [doc.uri]: r.edits.map((e) => TextEdit.replace(e.range, e.newText)) } };
}));

documents.listen(connection);
connection.listen();
