import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const root = path.join(__dirname, "..", "..");
const readJson = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"));

describe("extension manifest", () => {
  const manifest = readJson("package.json");

  it("contributes the alan language for .alan files", () => {
    const [language] = manifest.contributes.languages;
    assert.equal(language.id, "alan");
    assert.deepEqual(language.extensions, [".alan"]);
  });

  it("points at a grammar whose scope name matches", () => {
    const [grammar] = manifest.contributes.grammars;
    assert.equal(grammar.language, "alan");
    assert.equal(grammar.scopeName, "source.alan");
    assert.equal(readJson(grammar.path).scopeName, "source.alan");
  });

  it("keeps @types/vscode within engines.vscode", () => {
    assert.equal(manifest.engines.vscode, `^${manifest.devDependencies["@types/vscode"]}`);
  });

  it("offers the four snippets", () => {
    const [entry] = manifest.contributes.snippets;
    const prefixes = Object.values(readJson(entry.path)).map((s) => (s as { prefix: string }).prefix);
    assert.deepEqual(prefixes.sort(), ["func", "if", "ifelse", "while"]);
  });
});
