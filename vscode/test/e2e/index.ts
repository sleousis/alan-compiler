// Entry point VS Code loads inside the test instance. It runs the compiled
// end-to-end tests next to this file with Mocha and fails when any fails.
import * as fs from "node:fs";
import * as path from "node:path";

export async function run(): Promise<void> {
  // Mocha is an ES module, so it comes in through a dynamic import.
  const { default: Mocha } = await import("mocha");
  const mocha = new Mocha({ ui: "bdd", color: true, timeout: 60_000 });
  for (const f of fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js"))) {
    mocha.addFile(path.join(__dirname, f));
  }
  await mocha.loadFilesAsync();
  const failures = await new Promise<number>((resolve) => mocha.run(resolve));
  if (failures > 0) throw new Error(`${failures} end-to-end test(s) failed.`);
}
