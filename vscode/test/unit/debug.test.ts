import { strict as assert } from "assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import { CompilerRef, RunResult, commandLine } from "../../src/client/compiler";
import {
  AlanDebugConfigurationProvider, DEFAULT_CONFIG, DebugBuilds, DebugDeps, NO_DEBUG_SUPPORT, NO_PROGRAM, SavedSource,
  WSL_REFUSAL, debugProgramPath, lldbLaunchConfig,
} from "../../src/client/debug";

it("builds a CodeLLDB launch configuration", () => {
  const c = lldbLaunchConfig("/tmp/x/h", "/src", "/src/h.alan");
  assert.equal(c.type, "lldb");
  assert.equal(c.request, "launch");
  assert.equal(c.program, "/tmp/x/h");
  assert.equal(c.terminal, "integrated");
});

describe("debug launch configuration", () => {
  it("has exactly the fields CodeLLDB gets", () => {
    assert.deepEqual(lldbLaunchConfig("/tmp/x/h", "/src", "/src/h.alan"), {
      type: "lldb", request: "launch", name: "Alan: h.alan", program: "/tmp/x/h", cwd: "/src",
      terminal: "integrated", sourceLanguages: ["c"], stopOnEntry: false,
    });
  });

  it("names the program after the source, with .exe on Windows", () => {
    const dir = path.join(os.tmpdir(), "alan-debug-x");
    assert.equal(debugProgramPath(dir, path.join("src", "h.alan"), "win32"), path.join(dir, "h.exe"));
    assert.equal(debugProgramPath(dir, path.join("src", "h.alan"), "linux"), path.join(dir, "h"));
    assert.equal(debugProgramPath(dir, path.join("src", "h.alan"), "darwin"), path.join(dir, "h"));
  });

  it("asks the compiler for -g and never for -O", () => {
    const ref = { exe: "alanc", wsl: false };
    assert.deepEqual(commandLine(ref, "build", "h.alan", { optimize: true, out: "o/h", debug: true }).args,
      ["build", "h.alan", "-o", "o/h", "-g"]);
    assert.deepEqual(commandLine(ref, "build", "h.alan", { optimize: true, out: "o/h" }).args,
      ["build", "h.alan", "-o", "o/h", "-O"]);
  });
});

interface Calls {
  errors: string[];
  reports: { detail: string | undefined; missing: boolean; stderr?: string }[];
  problems: string[];
  builds: { cmd: string; args: string[]; cwd: string }[];
  saved: string[];
  savedActive: number;
}

describe("AlanDebugConfigurationProvider", () => {
  let root: string;
  const src = path.join(os.tmpdir(), "alan src", "h.alan");
  const native: CompilerRef = { exe: "alanc", wsl: false };

  before(() => { root = mkdtempSync(path.join(os.tmpdir(), "alan-debug-test-")); });
  after(() => rmSync(root, { recursive: true, force: true }));

  const leftovers = () => readdirSync(root);

  function setup(o: {
    wsl?: boolean; ref?: CompilerRef | undefined; result?: RunResult; saved?: string | undefined; active?: string | undefined;
    platform?: NodeJS.Platform;
  } = {}) {
    const calls: Calls = { errors: [], reports: [], problems: [], builds: [], saved: [], savedActive: 0 };
    const source = (file: string): SavedSource => ({ file, showProblems: (s) => calls.problems.push(s) });
    const builds = new DebugBuilds(root);
    const deps: DebugDeps = {
      platform: o.platform ?? "linux",
      useWsl: () => o.wsl ?? false,
      saveActive: async () => {
        calls.savedActive++;
        const f = "active" in o ? o.active : src;
        return f === undefined ? undefined : source(f);
      },
      save: async (file) => {
        calls.saved.push(file);
        return "saved" in o && o.saved === undefined ? undefined : source(file);
      },
      findCompiler: async () => ("ref" in o ? o.ref : native),
      build: async (cmd, args, cwd) => {
        calls.builds.push({ cmd, args, cwd });
        return o.result ?? { code: 0, stdout: "", stderr: "" };
      },
      report: (detail, missing, stderr) => calls.reports.push(stderr === undefined ? { detail, missing } : { detail, missing, stderr }),
      showError: (m) => calls.errors.push(m),
      builds,
    };
    return { calls, builds, provider: new AlanDebugConfigurationProvider(deps) };
  }

  const alanConfig = (program: string): vscode.DebugConfiguration =>
    ({ type: "alan", request: "launch", name: "Debug Alan file", program });

  describe("first step", () => {
    it("turns F5 without launch.json into the default configuration for the saved active file", async () => {
      const { provider, calls } = setup();
      const c = await provider.resolveDebugConfiguration(undefined, { type: "", request: "", name: "" });
      assert.deepEqual(c, { ...DEFAULT_CONFIG, program: src, noDebug: undefined });
      assert.equal(calls.savedActive, 1);
    });

    it("keeps Run Without Debugging", async () => {
      const { provider } = setup();
      const c = await provider.resolveDebugConfiguration(undefined, { type: "", request: "", name: "", noDebug: true });
      assert.equal(c?.noDebug, true);
    });

    it("cancels when the active file is not saved", async () => {
      const { provider } = setup({ active: undefined });
      assert.equal(await provider.resolveDebugConfiguration(undefined, alanConfig("${file}")), undefined);
    });

    it("leaves a program path alone", async () => {
      const { provider, calls } = setup();
      const c = alanConfig("${workspaceFolder}/h.alan");
      assert.deepEqual(await provider.resolveDebugConfiguration(undefined, c), c);
      assert.equal(calls.savedActive, 0);
    });

    it("refuses in WSL mode before saving anything", async () => {
      const { provider, calls } = setup({ wsl: true });
      assert.equal(await provider.resolveDebugConfiguration(undefined, { type: "", request: "", name: "" }), undefined);
      assert.deepEqual(calls.errors, [WSL_REFUSAL]);
      assert.equal(calls.savedActive, 0);
    });

    it("offers the default configuration for a new launch.json", () => {
      const { provider } = setup();
      assert.deepEqual(provider.provideDebugConfigurations(), [DEFAULT_CONFIG]);
    });
  });

  describe("second step", () => {
    it("builds with -g into a new folder and hands the program to CodeLLDB", async () => {
      const { provider, calls, builds } = setup();
      const c = await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, alanConfig(src));
      assert.ok(c);
      const dir = path.dirname(c.program);
      assert.equal(path.dirname(dir), root);
      assert.ok(existsSync(dir));
      assert.deepEqual(c, lldbLaunchConfig(path.join(dir, "h"), path.dirname(src), src));
      assert.deepEqual(calls.builds, [{ cmd: "alanc", args: ["build", src, "-o", c.program, "-g"], cwd: path.dirname(src) }]);
      assert.deepEqual(calls.saved, [src]);
      assert.deepEqual(calls.problems, [""]);
      assert.deepEqual(calls.reports, []);

      // macOS keeps the object next to the program.
      writeFileSync(c.program, "");
      writeFileSync(`${c.program}.o`, "");
      await builds.ended(c.program);
      assert.equal(existsSync(dir), false);
    });

    it("names the Windows program .exe", async () => {
      const { provider, builds } = setup({ platform: "win32" });
      const c = await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, alanConfig(src));
      assert.equal(path.basename(c?.program), "h.exe");
      await builds.ended(c?.program);
    });

    it("keeps Run Without Debugging", async () => {
      const { provider, builds } = setup();
      const c = await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, { ...alanConfig(src), noDebug: true });
      assert.equal(c?.noDebug, true);
      await builds.ended(c?.program);
    });

    it("uses the active file when the configuration has no type", async () => {
      const { provider, calls, builds } = setup();
      const c = await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, { type: "", request: "", name: "" });
      assert.equal(calls.savedActive, 1);
      assert.equal(c?.type, "lldb");
      await builds.ended(c?.program);
    });

    it("finds a relative program in the workspace folder", async () => {
      const { provider, calls, builds } = setup();
      const folderPath = path.join(os.tmpdir(), "ws");
      const folder = { uri: { fsPath: folderPath }, name: "ws", index: 0 } as unknown as vscode.WorkspaceFolder;
      const c = await provider.resolveDebugConfigurationWithSubstitutedVariables(folder, alanConfig(path.join("sub", "h.alan")));
      assert.deepEqual(calls.saved, [path.join(folderPath, "sub", "h.alan")]);
      await builds.ended(c?.program);
    });

    it("asks for a program when there is none", async () => {
      const { provider, calls } = setup();
      const c = await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, { type: "alan", request: "launch", name: "x" });
      assert.equal(c, undefined);
      assert.deepEqual(calls.errors, [NO_PROGRAM]);
      assert.deepEqual(calls.builds, []);
    });

    it("stops when saving fails or there is no compiler", async () => {
      for (const o of [{ saved: undefined }, { ref: undefined }]) {
        const { provider, calls } = setup(o);
        assert.equal(await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, alanConfig(src)), undefined);
        assert.deepEqual(calls.builds, []);
      }
      assert.deepEqual(leftovers(), []);
    });

    it("refuses in WSL mode and for a compiler inside WSL", async () => {
      for (const o of [{ wsl: true }, { ref: { exe: "alanc", wsl: true } }]) {
        const { provider, calls } = setup(o);
        assert.equal(await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, alanConfig(src)), undefined);
        assert.deepEqual(calls.errors, [WSL_REFUSAL]);
        assert.deepEqual(calls.builds, []);
      }
    });

    it("shows compile errors in Problems, reports them and removes the folder", async () => {
      const stderr = "h.alan:5: error: Unknown name y\nThe alan compiler is lazy and aborts...\n";
      const { provider, calls } = setup({ result: { code: 1, stdout: "", stderr } });
      assert.equal(await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, alanConfig(src)), undefined);
      assert.deepEqual(calls.problems, [stderr]);
      assert.deepEqual(calls.reports, [{ detail: "h.alan:5: error: Unknown name y", missing: false, stderr }]);
      assert.deepEqual(leftovers(), []);
    });

    it("reports a missing compiler, a timeout and other failures", async () => {
      const cases: [RunResult, { detail: string | undefined; missing: boolean }][] = [
        [{ code: null, stdout: "", stderr: "", failure: "missing", detail: "spawn alanc ENOENT" },
          { detail: "spawn alanc ENOENT", missing: true }],
        [{ code: null, stdout: "", stderr: "", failure: "timeout", detail: "killed" },
          { detail: "the compiler took too long", missing: false }],
        [{ code: null, stdout: "", stderr: "", failure: "error", detail: "boom" }, { detail: "boom", missing: false }],
      ];
      for (const [result, report] of cases) {
        const { provider, calls } = setup({ result });
        assert.equal(await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, alanConfig(src)), undefined);
        assert.deepEqual(calls.reports, [report]);
        assert.deepEqual(calls.problems, []);
      }
      assert.deepEqual(leftovers(), []);
    });

    it("cancels quietly when the build is stopped", async () => {
      const { provider, calls } = setup({ result: { code: null, stdout: "", stderr: "", failure: "aborted" } });
      assert.equal(await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, alanConfig(src)), undefined);
      assert.deepEqual(calls.reports, []);
      assert.deepEqual(calls.errors, []);
      assert.deepEqual(leftovers(), []);
    });

    it("tells the user to update a compiler without -g", async () => {
      const stderr = "usage: alanc <file.alan> [-O]           print LLVM IR\n       alanc check <file.alan>          check only\n";
      const { provider, calls } = setup({ result: { code: 2, stdout: "", stderr } });
      assert.equal(await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, alanConfig(src)), undefined);
      assert.deepEqual(calls.reports, [{ detail: NO_DEBUG_SUPPORT, missing: false, stderr }]);
      assert.deepEqual(leftovers(), []);
    });
  });
});

describe("DebugBuilds", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), "alan-builds-test-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("removes only the folder of the session that ended", async () => {
    const b = new DebugBuilds(root);
    const one = await b.create();
    const two = await b.create();
    assert.notEqual(one, two);
    b.started(path.join(one, "h"), one);
    b.started(path.join(two, "h"), two);
    await b.ended(path.join(os.tmpdir(), "other"));
    await b.ended(undefined);
    assert.ok(existsSync(one) && existsSync(two));
    await b.ended(path.join(one, "h"));
    assert.equal(existsSync(one), false);
    assert.ok(existsSync(two));
  });

  it("removes every folder still in use when the extension stops", async () => {
    const b = new DebugBuilds(root);
    const dir = await b.create();
    mkdirSync(path.join(dir, "nested"));
    b.started(path.join(dir, "h"), dir);
    b.removeAll();
    assert.deepEqual(readdirSync(root), []);
  });
});
