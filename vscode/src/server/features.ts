// The editor features as pure functions of the source text. server.ts
// registers them with the connection, and the unit tests import them here.
export { analyzeSource } from "./analysis";
export type { SourceAnalysis } from "./analysis";
export { computeDiagnostics, mergeDiagnostics } from "./diagnostics";
export { completions } from "./completion";
export type { CompletionEntry } from "./completion";
export { hover, signatureHelp } from "./hover";
export type { SignatureInfo } from "./hover";
export { definition, documentSymbols } from "./symbols";
export type { OutlineSymbol } from "./symbols";
