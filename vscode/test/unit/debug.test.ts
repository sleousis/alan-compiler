import { strict as assert } from "assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import { CompilerRef, RunResult, commandLine } from "../../src/client/compiler";
import {
  AlanDebugConfigurationProvider, DEFAULT_CONFIG, DebugBuilds, DebugDeps, NO_DEBUG_SUPPORT, NO_FOLDER, NO_PROGRAM,
  SavedSource, UNKNOWN_VARIABLE, WSL_REFUSAL, debugProgramPath, dynamicProvider, lldbLaunchConfig, programPath,
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

  const resolve = (provider: AlanDebugConfigurationProvider, config: vscode.DebugConfiguration, folder?: string) =>
    provider.resolveDebugConfiguration(
      folder === undefined ? undefined : ({ uri: { fsPath: folder }, name: "ws", index: 0 } as unknown as vscode.WorkspaceFolder),
      config);

  it("builds F5 without launch.json from the saved active file and hands the program to CodeLLDB", async () => {
    const { provider, calls, builds } = setup();
    const c = await resolve(provider, { type: "", request: "", name: "" });
    assert.ok(c);
    const dir = path.dirname(c.program);
    assert.equal(path.dirname(dir), root);
    assert.ok(existsSync(dir));
    assert.deepEqual(c, lldbLaunchConfig(path.join(dir, "h"), path.dirname(src), src));
    assert.equal(calls.savedActive, 1);
    assert.deepEqual(calls.builds, [{ cmd: "alanc", args: ["build", src, "-o", c.program, "-g"], cwd: path.dirname(src) }]);
    assert.deepEqual(calls.problems, [""]);
    assert.deepEqual(calls.reports, []);

    // macOS keeps the object next to the program.
    writeFileSync(c.program, "");
    writeFileSync(`${c.program}.o`, "");
    await builds.ended(c.program);
    assert.equal(existsSync(dir), false);
  });

  it("passes a built configuration on untouched, so a second resolver cannot cancel it", async () => {
    const { provider, calls, builds } = setup();
    const first = await resolve(provider, alanConfig("${file}"));
    assert.ok(first);
    const again = await resolve(provider, first);
    assert.equal(again, first);
    assert.equal(calls.builds.length, 1);
    assert.equal(calls.savedActive, 1);
    assert.deepEqual(calls.saved, []);
    assert.ok(existsSync(first.program.replace(/[\\/][^\\/]+$/, "")));
    await builds.ended(first.program);
  });

  it("registers no resolvers for the dynamic trigger", () => {
    const { provider } = setup();
    const dynamic = dynamicProvider(provider);
    assert.deepEqual(Object.keys(dynamic), ["provideDebugConfigurations"]);
    assert.deepEqual(dynamic.provideDebugConfigurations?.(undefined), [DEFAULT_CONFIG]);
  });

  it("offers the default configuration for a new launch.json", () => {
    const { provider } = setup();
    assert.deepEqual(provider.provideDebugConfigurations(), [DEFAULT_CONFIG]);
  });

  it("passes Run Without Debugging and the user's own fields to CodeLLDB", async () => {
    const { provider, builds } = setup();
    const c = await resolve(provider, {
      ...alanConfig("${file}"), noDebug: true, args: ["a b"], env: { X: "1" }, cwd: "/elsewhere", preLaunchTask: "t",
    });
    assert.ok(c);
    assert.equal(c.type, "lldb");
    assert.equal(c.noDebug, true);
    assert.deepEqual(c.args, ["a b"]);
    assert.deepEqual(c.env, { X: "1" });
    assert.equal(c.cwd, "/elsewhere");
    assert.equal(c.preLaunchTask, "t");
    assert.equal(c.terminal, "integrated");
    await builds.ended(c.program);
  });

  it("names the Windows program .exe", async () => {
    const { provider, builds } = setup({ platform: "win32" });
    const c = await resolve(provider, alanConfig(src));
    assert.equal(path.basename(c?.program), "h.exe");
    await builds.ended(c?.program);
  });

  it("fills in ${workspaceFolder} and relative paths from the folder", async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), "alan ws-"));
    try {
      for (const program of ["${workspaceFolder}/sub/h.alan", path.join("sub", "h.alan")]) {
        const { provider, calls, builds } = setup();
        const c = await resolve(provider, alanConfig(program), ws);
        assert.deepEqual(calls.saved, [path.join(ws, "sub", "h.alan")]);
        assert.equal(calls.builds[0].args[1], path.join(ws, "sub", "h.alan"));
        assert.equal(c?.cwd, path.join(ws, "sub"));
        await builds.ended(c?.program);
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("finds the program settings it cannot fill in", () => {
    assert.deepEqual(programPath(undefined, "/w"), { error: NO_PROGRAM });
    assert.deepEqual(programPath("  ", "/w"), { error: NO_PROGRAM });
    assert.deepEqual(programPath("${file}", undefined), { active: true });
    assert.deepEqual(programPath("${workspaceFolder}/h.alan", undefined), { error: NO_FOLDER });
    assert.deepEqual(programPath("h.alan", undefined), { error: NO_FOLDER });
    assert.deepEqual(programPath("${fileDirname}/h.alan", "/w"), { error: UNKNOWN_VARIABLE });
    const abs = path.join(os.tmpdir(), "h.alan");
    assert.deepEqual(programPath(abs, undefined), { file: abs });
  });

  it("shows why a program cannot be found and builds nothing", async () => {
    const { provider, calls } = setup();
    assert.equal(await resolve(provider, { type: "alan", request: "launch", name: "x" }), undefined);
    assert.equal(await resolve(provider, alanConfig("h.alan")), undefined);
    assert.deepEqual(calls.errors, [NO_PROGRAM, NO_FOLDER]);
    assert.deepEqual(calls.builds, []);
  });

  it("stops when saving fails or there is no compiler", async () => {
    for (const o of [{ saved: undefined }, { active: undefined }, { ref: undefined }]) {
      const { provider, calls } = setup(o);
      assert.equal(await resolve(provider, alanConfig("saved" in o ? src : "${file}")), undefined);
      assert.deepEqual(calls.builds, []);
    }
    assert.deepEqual(leftovers(), []);
  });

  it("refuses in WSL mode before saving, and for a compiler inside WSL", async () => {
    for (const o of [{ wsl: true }, { ref: { exe: "alanc", wsl: true } }]) {
      const { provider, calls } = setup(o);
      assert.equal(await resolve(provider, { type: "", request: "", name: "" }), undefined);
      assert.deepEqual(calls.errors, [WSL_REFUSAL]);
      assert.deepEqual(calls.builds, []);
      if (o.wsl) assert.equal(calls.savedActive, 0);
    }
  });

  it("shows compile errors in Problems, reports them and removes the folder", async () => {
    const stderr = "h.alan:5: error: Unknown name y\nThe alan compiler is lazy and aborts...\n";
    const { provider, calls } = setup({ result: { code: 1, stdout: "", stderr } });
    assert.equal(await resolve(provider, alanConfig(src)), undefined);
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
      assert.equal(await resolve(provider, alanConfig(src)), undefined);
      assert.deepEqual(calls.reports, [report]);
      assert.deepEqual(calls.problems, []);
    }
    assert.deepEqual(leftovers(), []);
  });

  it("cancels quietly when the build is stopped", async () => {
    const { provider, calls } = setup({ result: { code: null, stdout: "", stderr: "", failure: "aborted" } });
    assert.equal(await resolve(provider, alanConfig(src)), undefined);
    assert.deepEqual(calls.reports, []);
    assert.deepEqual(calls.errors, []);
    assert.deepEqual(leftovers(), []);
  });

  it("tells the user to update a compiler without -g", async () => {
    const stderr = "usage: alanc <file.alan> [-O]           print LLVM IR\n       alanc check <file.alan>          check only\n";
    const { provider, calls } = setup({ result: { code: 2, stdout: "", stderr } });
    assert.equal(await resolve(provider, alanConfig(src)), undefined);
    assert.deepEqual(calls.reports, [{ detail: NO_DEBUG_SUPPORT, missing: false, stderr }]);
    assert.deepEqual(leftovers(), []);
  });
});

describe("DebugBuilds", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), "alan-builds-test-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("removes only the folder of the session that ended", async () => {
    const b = new DebugBuilds(root);
    const one = await b.create();
    const two = await b.create();
    assert.notEqual(one, two);
    b.built(path.join(one, "h"), one);
    b.built(path.join(two, "h"), two);
    await b.ended(path.join(os.tmpdir(), "other"));
    await b.ended(undefined);
    assert.ok(existsSync(one) && existsSync(two));
    await b.ended(path.join(one, "h"));
    assert.equal(existsSync(one), false);
    assert.ok(existsSync(two));
    b.removeAll();
  });

  it("removes a build whose session never started, and keeps one that did", async () => {
    const b = new DebugBuilds(root);
    const lost = await b.create();
    const running = await b.create();
    b.built(path.join(lost, "h"), lost, 50);
    b.built(path.join(running, "h"), running, 50);
    b.started(path.join(running, "h"));
    await wait(300);
    assert.equal(existsSync(lost), false);
    assert.ok(existsSync(running));
    await b.ended(path.join(running, "h"));
    assert.equal(existsSync(running), false);
  });

  it("removes old folders left by an earlier VS Code, and nothing else", async () => {
    const b = new DebugBuilds(root);
    const old = await b.create();
    const recent = await b.create();
    const inUse = await b.create();
    b.built(path.join(inUse, "h"), inUse);
    mkdirSync(path.join(root, "someone-else"));
    const day = 24 * 60 * 60_000;
    const past = new Date(Date.now() - 2 * day);
    utimesSync(old, past, past);
    utimesSync(inUse, past, past);
    await b.sweep(day);
    assert.deepEqual(readdirSync(root).sort(), [path.basename(inUse), path.basename(recent), "someone-else"].sort());
    b.removeAll();
  });

  it("logs a folder it cannot remove", async () => {
    const lines: string[] = [];
    const b = new DebugBuilds(root, (l) => lines.push(l));
    // No system accepts a path with a NUL byte.
    await b.remove(path.join(root, "a\0b"));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Cannot remove the debug build/);
  });

  it("removes every folder still in use when the extension stops", async () => {
    const b = new DebugBuilds(root);
    const dir = await b.create();
    mkdirSync(path.join(dir, "nested"));
    b.built(path.join(dir, "h"), dir);
    b.removeAll();
    assert.deepEqual(readdirSync(root), []);
  });
});
