// Runs the end-to-end tests: bundles them into out/e2e, downloads VS Code
// and starts it with the extension and the tests.
// Run from the vscode folder with `npm run test:e2e` after `npm run build`.
//
// The extension depends on CodeLLDB, and VS Code refuses to activate it
// without that. The tests do not debug, so a stand-in with CodeLLDB's id
// (codelldb-stub) loads next to the extension instead of the real one. An
// installed CodeLLDB made the runs flaky: VS Code replaced it with its
// platform build in the background, and for that moment the dependency was
// gone, so activation failed or a request came back empty.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const outDir = path.join(root, "out", "e2e");
const testDir = path.join(root, ".vscode-test");

fs.rmSync(outDir, { recursive: true, force: true });
await esbuild.build({
  entryPoints: ["test/e2e/index.ts", "test/e2e/extension.test.ts"],
  absWorkingDir: root,
  outdir: outDir,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode", "mocha"],
  logLevel: "warning",
});

/** The download can fail on a busy network, so it gets a few tries. */
async function retry(what, fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt === 4) throw e;
      console.warn(`${what} failed (attempt ${attempt}): ${e instanceof Error ? e.message : e}`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}

const vscodeExecutablePath = await retry("Downloading VS Code", () => downloadAndUnzipVSCode("stable"));

// A fresh profile and no installed extensions each time, so nothing from an
// earlier run comes back.
const userData = path.join(testDir, "user-data");
const extensions = path.join(testDir, "extensions");
fs.rmSync(userData, { recursive: true, force: true });
fs.rmSync(extensions, { recursive: true, force: true });

try {
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: [root, path.join(here, "codelldb-stub")],
    extensionTestsPath: path.join(outDir, "index.js"),
    launchArgs: [`--user-data-dir=${userData}`, `--extensions-dir=${extensions}`],
  });
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
