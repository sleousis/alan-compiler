// Regenerates the Marketplace images images/editor.png and images/run.gif
// from the real extension running in a real VS Code. Windows only; needs
// Python with Pillow for the GIF.
//
// From the vscode folder:
//   node tools/capture-screenshots.mjs --compiler <path to alanc.exe> [--work <dir>]
//
// The compiler is a Windows alanc bundle, for example the alan-dev-windows-x64
// artifact of a green CI run, and must be able to link (it runs HelloWorld
// once before anything else). --work is a scratch folder for the demo files,
// a fresh VS Code profile and the recorded frames (default: a folder in the
// system temp folder). The Run terminal prints the full paths of the
// compiler and the file, so keep both in a folder whose path is fine to show.
//
// It packages the extension from this folder, installs it with CodeLLDB and
// the driver in tools/capture into an empty VS Code profile, and starts VS
// Code. The driver opens the files, records a Run, shows the completion list
// and a live error, has tools/capture-window.ps1 photograph the VS Code
// window only, and quits. tools/make-gif.py turns the frames into
// images/run.gif. The work folder also keeps editor-hover.png (the error's
// hover), as an alternative still.
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from "@vscode/test-electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const repo = path.resolve(root, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const compiler = arg("compiler");
if (!compiler || !fs.existsSync(compiler)) {
  console.error("Usage: node tools/capture-screenshots.mjs --compiler <alanc.exe> [--work <dir>]");
  process.exit(1);
}
const work = path.resolve(arg("work", path.join(os.tmpdir(), "alan-capture")));
const demo = path.join(work, "examples");
const profile = path.join(work, "profile");
const frames = path.join(work, "frames");
const images = path.join(root, "images");

// A fresh demo folder, profile and frames each time.
for (const dir of [demo, profile, frames]) fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(demo, { recursive: true });
fs.mkdirSync(images, { recursive: true });

// HelloWorld as it is, and BubbleSort with one deliberate mistake: the last
// call names an array that was never declared.
fs.copyFileSync(path.join(repo, "Examples", "HelloWorld.alan"), path.join(demo, "HelloWorld.alan"));
const bubble = fs.readFileSync(path.join(repo, "Examples", "BubbleSort.alan"), "utf8");
const broken = bubble.replace('writeArray("Sorted array: ", 16, x);', 'writeArray("Sorted array: ", 16, sorted);');
if (broken === bubble) throw new Error("BubbleSort.alan changed; update the deliberate mistake.");
fs.writeFileSync(path.join(demo, "BubbleSort.alan"), broken);

const settings = {
  "workbench.colorTheme": "Default Dark Modern",
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "workbench.editor.empty.hint": "hidden",
  "editor.stickyScroll.enabled": false,
  "window.restoreWindows": "none",
  "window.commandCenter": true,
  "chat.disableAIFeatures": true,
  "chat.commandCenter.enabled": false,
  "security.workspace.trust.enabled": false,
  "extensions.ignoreRecommendations": true,
  "extensions.autoUpdate": false,
  "extensions.autoCheckUpdates": false,
  "update.mode": "none",
  "telemetry.telemetryLevel": "off",
  "git.enabled": false,
  "alan.compilerPath": path.resolve(compiler),
};
const userDir = path.join(profile, "user-data", "User");
fs.mkdirSync(userDir, { recursive: true });
fs.writeFileSync(path.join(userDir, "settings.json"), JSON.stringify(settings, null, 2));

// The first run of a new compiler fills zig's cache, which takes a while. One
// run first, so the recording shows the Run as fast as it is from then on.
execFileSync(compiler, ["run", path.join(demo, "HelloWorld.alan"), "-O"], { cwd: demo, stdio: "inherit" });

// The Alan extension as users get it, and the driver as a second extension.
const vsix = path.join(work, "alan.vsix");
const driverDir = path.join(work, "driver");
const driverVsix = path.join(work, "driver.vsix");
fs.rmSync(driverDir, { recursive: true, force: true });
const vsce = (args, cwd) => execFileSync("npx", ["vsce", "package", ...args], { cwd, stdio: "inherit", shell: true });
vsce(["--baseContentUrl", "https://github.com/sleousis/alan-compiler/blob/HEAD/vscode",
  "--baseImagesUrl", "https://github.com/sleousis/alan-compiler/raw/HEAD/vscode", "-o", vsix], root);
await esbuild.build({
  entryPoints: [path.join(here, "capture", "driver.ts")],
  outfile: path.join(driverDir, "driver.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode"],
  logLevel: "warning",
});
fs.writeFileSync(path.join(driverDir, "package.json"), JSON.stringify({
  name: "alan-capture-driver",
  displayName: "Alan screenshot driver",
  description: "Drives the Alan extension for tools/capture-screenshots.mjs.",
  publisher: "local",
  license: "MIT",
  version: "0.0.1",
  engines: { vscode: "^1.104.0" },
  main: "./driver.js",
  activationEvents: ["onStartupFinished"],
}, null, 2));
fs.writeFileSync(path.join(driverDir, "README.md"), "Drives the Alan extension for tools/capture-screenshots.mjs.\n");
fs.copyFileSync(path.join(root, "LICENSE"), path.join(driverDir, "LICENSE"));
vsce(["--allow-missing-repository", "-o", driverVsix], driverDir);

const vscodeExecutablePath = await downloadAndUnzipVSCode("stable");
const profileArgs = [`--user-data-dir=${path.join(profile, "user-data")}`, `--extensions-dir=${path.join(profile, "extensions")}`];
const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
// The real CodeLLDB, since the Alan extension depends on it.
for (const ext of [vsix, driverVsix, "vadimcn.vscode-lldb"]) {
  execFileSync(cli, [...cliArgs.filter((a) => !a.startsWith("--extensions-dir") && !a.startsWith("--user-data-dir")),
    ...profileArgs, "--install-extension", ext], { stdio: "inherit", shell: true });
}

const result = path.join(work, "driver-result.txt");
fs.rmSync(result, { force: true });
const config = { script: path.join(here, "capture-window.ps1"), demo, shots: work, frames, result, width: 1280, height: 800 };
const code = spawn(vscodeExecutablePath, [demo, ...profileArgs, "--skip-welcome", "--skip-release-notes",
  "--disable-workspace-trust", "--disable-updates", "--new-window"], {
  env: { ...process.env, ALAN_CAPTURE_CONFIG: JSON.stringify(config) },
  stdio: "ignore",
});
const timer = setTimeout(() => code.kill(), 300_000);
await new Promise((resolve) => code.on("exit", resolve));
clearTimeout(timer);
const outcome = fs.existsSync(result) ? fs.readFileSync(result, "utf8") : "VS Code closed before the driver finished.";
if (outcome !== "ok") {
  console.error(outcome);
  process.exit(1);
}

fs.copyFileSync(path.join(work, "editor.png"), path.join(images, "editor.png"));
execFileSync("python", [path.join(here, "make-gif.py"), frames, path.join(images, "run.gif")], { stdio: "inherit" });
console.log(`Wrote ${path.join(images, "editor.png")} and ${path.join(images, "run.gif")}.`);
