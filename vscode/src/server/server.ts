// Entry point of the language server. It creates the LSP connection and
// registers the features of features.ts. It keeps the last analysis of a
// clean text per document, so completion still works while the current text
// has a syntax error.
import {
  CompletionItem, CompletionItemKind, Diagnostic, DiagnosticSeverity, DocumentSymbol, MarkupKind,
  ProposedFeatures, SymbolKind, TextDocumentSyncKind, TextDocuments, createConnection,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  CompletionEntry, OutlineSymbol, analyzeSource, completions, computeDiagnostics, definition, documentSymbols,
  hover, mergeDiagnostics, signatureHelp,
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
  const text = doc.getText();
  const { analysis, clean } = analyzeSource(text);
  if (clean && analysis) s.lastGood = analysis;
  s.live = computeDiagnostics(text).map((d) => ({
    range: d.range,
    message: d.message,
    severity: d.severity === "error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
    source: d.source,
  }));
  publish(doc.uri);
}

function schedule(doc: TextDocument) {
  const s = state(doc.uri);
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = undefined;
    const current = documents.get(doc.uri);
    if (current) refresh(current);
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

connection.onCompletion((p): CompletionItem[] => {
  const doc = documents.get(p.textDocument.uri);
  if (!doc) return [];
  return completions(doc.getText(), p.position, states.get(doc.uri)?.lastGood).map((c) => {
    const item: CompletionItem = { label: c.label, kind: COMPLETION_KINDS[c.kind] };
    if (c.detail) item.detail = c.detail;
    if (c.documentation) item.documentation = c.documentation;
    if (c.insertText) item.insertText = c.insertText;
    return item;
  });
});

connection.onHover((p) => {
  const doc = documents.get(p.textDocument.uri);
  const text = doc && hover(doc.getText(), p.position);
  return text ? { contents: { kind: MarkupKind.Markdown, value: text } } : null;
});

connection.onSignatureHelp((p) => {
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
});

connection.onDefinition((p) => {
  const doc = documents.get(p.textDocument.uri);
  const range = doc && definition(doc.getText(), p.position);
  return range ? { uri: p.textDocument.uri, range } : null;
});

function toDocumentSymbol(s: OutlineSymbol): DocumentSymbol {
  return {
    name: s.name,
    kind: s.kind === "function" ? SymbolKind.Function : SymbolKind.Variable,
    range: s.range,
    selectionRange: s.selectionRange,
    children: s.children.map(toDocumentSymbol),
  };
}

connection.onDocumentSymbol((p) => {
  const doc = documents.get(p.textDocument.uri);
  return doc ? documentSymbols(doc.getText()).map(toDocumentSymbol) : [];
});

documents.listen(connection);
connection.listen();
