// Runs the end-to-end tests: bundles them into out/e2e, downloads VS Code,
// installs CodeLLDB (the extension depends on it, so it would not activate
// without it) and starts VS Code with the extension and the tests.
// Run from the vscode folder with `npm run test:e2e` after `npm run build`.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from "@vscode/test-electron";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(root, "out", "e2e");
const CODELLDB = "vadimcn.vscode-lldb";

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

/** Downloads can fail on a busy network, so each gets a few tries. */
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
const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);

const listed = spawnSync(cli, [...cliArgs, "--list-extensions"], { encoding: "utf8", shell: process.platform === "win32" });
if (!listed.stdout?.toLowerCase().split(/\r?\n/).includes(CODELLDB)) {
  await retry(`Installing ${CODELLDB}`, async () => {
    const r = spawnSync(cli, [...cliArgs, "--install-extension", CODELLDB], {
      encoding: "utf8", stdio: "inherit", shell: process.platform === "win32",
    });
    if (r.status !== 0) throw new Error(`exit code ${r.status}`);
  });
}

// A fresh profile each time, so no window or editor from an earlier run comes back.
fs.rmSync(path.join(root, ".vscode-test", "user-data"), { recursive: true, force: true });

try {
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(outDir, "index.js"),
  });
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
