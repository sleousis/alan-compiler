import { strict as assert } from "assert";
import {
  buildOutputPath, commandLine, failureSummary, locateCompiler, needsSaveAs, parseCompilerOutput, runCompiler, searchPath,
  WSL_LAUNCH,
} from "../../src/client/compiler";
import { toWslPath } from "../../src/client/wsl";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkFile, compilerDiagnostics } from "../../src/server/compilerCheck";

describe("compiler glue", () => {
  it("parses file:line: error lines", () => {
    const r = parseCompilerOutput("x.alan:5: error: Unknown name y\nother\n", "x.alan");
    assert.deepEqual(r, [{ line: 4, message: "Unknown name y" }]);
  });
  it("ignores colour codes", () => {
    const r = parseCompilerOutput("x.alan:2: \u001b[1;31merror:\u001b[0m bad\n", "x.alan");
    assert.equal(r[0].message, "bad");
  });
  it("translates Windows paths for WSL", () => {
    assert.equal(toWslPath("C:\\Users\\Σάββας\\a b\\h.alan"), "/mnt/c/Users/Σάββας/a b/h.alan");
  });
  it("builds argument arrays without shell quoting", () => {
    const c = commandLine({ exe: "C:\\t\\alanc.exe", wsl: false }, "run", "C:\\a b\\h.alan", { optimize: true });
    assert.deepEqual(c, { cmd: "C:\\t\\alanc.exe", args: ["run", "C:\\a b\\h.alan", "-O"] });
  });
});

describe("parseCompilerOutput", () => {
  // Real stderr of alanc check, captured with and without a terminal.
  const lazy = "The alan compiler is lazy and aborts...\n";

  it("reads a real check failure and drops the abort line", () => {
    const r = parseCompilerOutput("bad file.alan:4: error: Identifier not found.\n" + lazy, "bad file.alan");
    assert.deepEqual(r, [{ line: 3, message: "Identifier not found." }]);
  });
  it("reads the coloured form a terminal gets, with CRLF line ends", () => {
    const r = parseCompilerOutput("\u001b[1mp.alan:3:\u001b[0m \u001b[1;31merror:\u001b[0m syntax error\r\n", "p.alan");
    assert.deepEqual(r, [{ line: 2, message: "syntax error" }]);
  });
  it("reads fatal and internal errors too", () => {
    const r = parseCompilerOutput("h.alan:7: fatal: Out of memory\nh.alan:9: internal: oops\n", "h.alan");
    assert.deepEqual(r, [{ line: 6, message: "Out of memory" }, { line: 8, message: "oops" }]);
  });
  it("ignores other files, errors without a line and warnings", () => {
    const r = parseCompilerOutput(
      "other.alan:1: error: no\nh.alan: error: the output file is the source file, use another -o\n" +
      "alanc: error: cannot open h.alan\nh.alan:3: warning: hm\n", "h.alan");
    assert.deepEqual(r, []);
  });
  it("matches names with spaces, Greek letters and regex characters literally", () => {
    assert.deepEqual(parseCompilerOutput("Σάββας (1)+.alan:2: error: x\n", "Σάββας (1)+.alan"), [{ line: 1, message: "x" }]);
    assert.deepEqual(parseCompilerOutput("aXalan:2: error: x\n", "a.alan"), []);
  });
  it("keeps colons in the message and clamps line 0", () => {
    assert.deepEqual(parseCompilerOutput("h.alan:0: error: a: b\n", "h.alan"), [{ line: 0, message: "a: b" }]);
  });
  it("summarises a failure by its first line, without the abort line", () => {
    assert.equal(failureSummary("\u001b[1mh.alan:\u001b[0m error: cannot run zig\r\nmore\n"), "h.alan: error: cannot run zig");
    assert.equal(failureSummary("The alan compiler is lazy and aborts...\n"), undefined);
  });
  it("returns nothing for empty output", () => {
    assert.deepEqual(parseCompilerOutput("", "h.alan"), []);
  });
});

describe("toWslPath", () => {
  it("maps drive letters to /mnt, lower case", () => {
    assert.equal(toWslPath("D:\\Git\\x.alan"), "/mnt/d/Git/x.alan");
    assert.equal(toWslPath("c:\\x.alan"), "/mnt/c/x.alan");
    assert.equal(toWslPath("C:\\"), "/mnt/c/");
    assert.equal(toWslPath("C:"), "/mnt/c");
  });
  it("accepts forward slashes and the long path prefix", () => {
    assert.equal(toWslPath("C:/a b/x.alan"), "/mnt/c/a b/x.alan");
    assert.equal(toWslPath("\\\\?\\C:\\a\\x.alan"), "/mnt/c/a/x.alan");
  });
  it("maps files inside WSL through \\\\wsl$ and \\\\wsl.localhost", () => {
    assert.equal(toWslPath("\\\\wsl$\\Ubuntu\\home\\s\\a b\\h.alan"), "/home/s/a b/h.alan");
    assert.equal(toWslPath("\\\\wsl.localhost\\Ubuntu-20.04\\home\\Σάββας\\h.alan"), "/home/Σάββας/h.alan");
    assert.equal(toWslPath("\\\\WSL.LOCALHOST\\Ubuntu\\tmp\\h.alan"), "/tmp/h.alan");
    assert.equal(toWslPath("//wsl$/Ubuntu/tmp/h.alan"), "/tmp/h.alan");
    assert.equal(toWslPath("\\\\wsl$\\Ubuntu"), "/");
  });
  it("keeps Linux paths as they are", () => {
    assert.equal(toWslPath("/home/s/h.alan"), "/home/s/h.alan");
  });
  it("rejects network shares and relative paths", () => {
    assert.throws(() => toWslPath("\\\\server\\share\\h.alan"), /WSL/);
    assert.throws(() => toWslPath("a\\h.alan"), /WSL/);
  });
});

describe("commandLine", () => {
  const native = { exe: "C:\\Program Files\\Alan\\alanc.exe", wsl: false };
  const wsl = { exe: "alanc", wsl: true };

  it("never passes -O to check", () => {
    assert.deepEqual(commandLine(native, "check", "C:\\a b\\h.alan", { optimize: true }),
      { cmd: native.exe, args: ["check", "C:\\a b\\h.alan"] });
  });
  it("puts -o before -O for build", () => {
    assert.deepEqual(commandLine(native, "build", "C:\\a\\h.alan", { optimize: true, out: "C:\\a\\h.exe" }),
      { cmd: native.exe, args: ["build", "C:\\a\\h.alan", "-o", "C:\\a\\h.exe", "-O"] });
    assert.deepEqual(commandLine(native, "build", "C:\\a\\h.alan", { optimize: false }),
      { cmd: native.exe, args: ["build", "C:\\a\\h.alan"] });
  });
  it("has no verb for IR", () => {
    assert.deepEqual(commandLine(native, "ir", "C:\\a\\h.alan", { optimize: true }),
      { cmd: native.exe, args: ["C:\\a\\h.alan", "-O"] });
  });
  it("runs WSL without a shell command line and translates every path", () => {
    assert.deepEqual(
      commandLine(wsl, "build", "C:\\Σάββας\\a b\\h.alan", { optimize: true, out: "C:\\Σάββας\\a b\\h" }),
      {
        cmd: "wsl.exe",
        args: ["-e", "sh", "-c", WSL_LAUNCH, "alanc", "build", "/mnt/c/Σάββας/a b/h.alan", "-o", "/mnt/c/Σάββας/a b/h", "-O"],
      });
    assert.deepEqual(commandLine(wsl, "run", "\\\\wsl$\\Ubuntu\\home\\s\\h.alan", { optimize: false }).args.slice(4),
      ["alanc", "run", "/home/s/h.alan"]);
  });
  it("finds alanc through ~/.local/bin inside WSL", () => {
    assert.match(WSL_LAUNCH, /\$HOME\/\.local\/bin/);
    assert.match(WSL_LAUNCH, /exec "\$0" "\$@"/);
  });
});

describe("buildOutputPath", () => {
  it("drops .alan and adds .exe for a Windows compiler", () => {
    assert.equal(buildOutputPath("C:\\a b\\Σ.alan", false, "win32"), "C:\\a b\\Σ.exe");
  });
  it("drops .alan for Linux, macOS and WSL", () => {
    assert.equal(buildOutputPath("/home/s/h.alan", false, "linux"), "/home/s/h");
    assert.equal(buildOutputPath("C:\\a\\h.alan", true, "win32"), "C:\\a\\h");
  });
  it("never names the source itself", () => {
    assert.equal(buildOutputPath("C:\\a\\.alan", false, "win32"), "C:\\a\\.alan.exe");
    assert.equal(buildOutputPath("/a/h.ALAN", false, "linux"), "/a/h.ALAN.out");
  });
});

describe("locating the compiler", () => {
  const files = (...names: string[]) => (p: string) => names.includes(p);

  it("searches PATH with the platform's separator and extension", () => {
    assert.equal(searchPath("alanc", "C:\\x;C:\\bin", "win32", files("C:\\bin\\alanc.exe")), "C:\\bin\\alanc.exe");
    assert.equal(searchPath("alanc", "/usr/bin:/opt/a b", "linux", files("/opt/a b/alanc")), "/opt/a b/alanc");
    assert.equal(searchPath("alanc", "", "linux", files()), undefined);
  });
  it("prefers the setting, then the installed copy, then PATH", () => {
    const base = { compilerPath: "", useWsl: false, platform: "linux" as const, installed: "/st/alanc", envPath: "/usr/bin" };
    assert.deepEqual(locateCompiler({ ...base, compilerPath: "/c/alanc" }, files("/c/alanc", "/st/alanc")),
      { exe: "/c/alanc", wsl: false });
    assert.deepEqual(locateCompiler(base, files("/st/alanc", "/usr/bin/alanc")), { exe: "/st/alanc", wsl: false });
    assert.deepEqual(locateCompiler(base, files("/usr/bin/alanc")), { exe: "/usr/bin/alanc", wsl: false });
    assert.equal(locateCompiler(base, files()), undefined);
  });
  it("does not fall back when the setting names a missing file", () => {
    const o = { compilerPath: "/gone/alanc", useWsl: false, platform: "linux" as const, envPath: "/usr/bin" };
    assert.equal(locateCompiler(o, files("/usr/bin/alanc")), undefined);
  });
  it("uses WSL only on Windows and ignores the setting elsewhere", () => {
    const o = { compilerPath: "", useWsl: true, envPath: "" };
    assert.deepEqual(locateCompiler({ ...o, platform: "win32" }, files()), { exe: "alanc", wsl: true });
    assert.deepEqual(locateCompiler({ ...o, platform: "win32", compilerPath: "/opt/alanc" }, files()),
      { exe: "/opt/alanc", wsl: true });
    assert.deepEqual(locateCompiler({ ...o, platform: "linux", envPath: "/usr/bin" }, files("/usr/bin/alanc")),
      { exe: "/usr/bin/alanc", wsl: false });
  });
});

describe("saving before a command", () => {
  it("asks for a file name when there is no file on disk", () => {
    assert.equal(needsSaveAs({ isUntitled: true, scheme: "untitled", existsOnDisk: false }), true);
    assert.equal(needsSaveAs({ isUntitled: false, scheme: "file", existsOnDisk: false }), true);
    assert.equal(needsSaveAs({ isUntitled: false, scheme: "git", existsOnDisk: false }), true);
    assert.equal(needsSaveAs({ isUntitled: false, scheme: "file", existsOnDisk: true }), false);
  });
});

describe("compiler diagnostics", () => {
  it("covers the reported line from its first non-blank character", () => {
    const text = "main () : proc\r\n{\r\n    y = 1;\r\n}\r\n";
    const d = compilerDiagnostics("h.alan:3: error: Identifier not found.\nThe alan compiler is lazy and aborts...\n", "h.alan", text);
    assert.equal(d.length, 1);
    assert.deepEqual(d[0].range, { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } });
    assert.equal(d[0].message, "Identifier not found.");
    assert.equal(d[0].severity, 1);
    assert.equal(d[0].source, "alanc");
  });
  it("keeps a line past the end of the text on the last line", () => {
    const d = compilerDiagnostics("h.alan:9: error: syntax error\n", "h.alan", "a\nbc");
    assert.deepEqual(d[0].range, { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } });
  });
  it("puts a failure without a line on the first line", () => {
    const d = compilerDiagnostics("alanc: error: cannot open h.alan\n", "h.alan", "  main\n", 1);
    assert.equal(d.length, 1);
    assert.equal(d[0].message, "alanc: error: cannot open h.alan");
    assert.deepEqual(d[0].range, { start: { line: 0, character: 2 }, end: { line: 0, character: 6 } });
    assert.equal(compilerDiagnostics("", "h.alan", "x", 127)[0].message, "alanc check failed with exit status 127.");
  });
  it("gives nothing for a clean exit or without an exit status", () => {
    assert.deepEqual(compilerDiagnostics("", "h.alan", "x", 0), []);
    assert.deepEqual(compilerDiagnostics("alanc: error: x\n", "h.alan", "x"), []);
  });
});

describe("checkFile", () => {
  // node stands in for the compiler: `node check <file>` fails to load "check".
  const node = { exe: process.execPath, wsl: false };
  const file = path.join(__dirname, "no such dir", "h.alan");

  it("never reports a failed check as clean", async () => {
    const d = await checkFile(node, file, "a\n");
    assert.ok(d);
    assert.equal(d.length, 1);
    assert.equal(d[0].range.start.line, 0);
    assert.ok(typeof d[0].message === "string" && d[0].message.length > 0);
  });
  it("logs a missing compiler and keeps the old diagnostics", async () => {
    const lines: string[] = [];
    const d = await checkFile({ exe: "no-such-alanc-here", wsl: false }, file, "", { log: (l) => lines.push(l) });
    assert.equal(d, undefined);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /failed: no-such-alanc-here not found/);
  });
  it("tells onMissing that the compiler is gone, and only then", async () => {
    let missing = 0;
    await checkFile({ exe: "no-such-alanc-here", wsl: false }, file, "", { onMissing: () => missing++ });
    assert.equal(missing, 1);
    await checkFile(node, file, "a\n", { onMissing: () => missing++ });
    assert.equal(missing, 1);
  });
  it("logs a path WSL cannot open", async () => {
    const lines: string[] = [];
    assert.equal(await checkFile({ exe: "alanc", wsl: true }, "\\\\server\\share\\h.alan", "", { log: (l) => lines.push(l) }), undefined);
    assert.match(lines[0], /skipped: WSL cannot open/);
  });
  it("stays quiet when aborted", async () => {
    const lines: string[] = [];
    const abort = new AbortController();
    const run = checkFile(node, file, "", { signal: abort.signal, log: (l) => lines.push(l) });
    abort.abort();
    assert.equal(await run, undefined);
    assert.deepEqual(lines, []);
  });
});

describe("runCompiler", () => {
  const node = process.execPath;

  it("passes arguments with spaces, quotes and Greek letters unchanged", async () => {
    const args = ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "a b", "Σάββας \"x\"", "$HOME;|"];
    const r = await runCompiler(node, args, { timeoutMs: 10000 });
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout), ["a b", "Σάββας \"x\"", "$HOME;|"]);
  });
  it("returns stderr and the exit status of a failure", async () => {
    const r = await runCompiler(node, ["-e", "process.stderr.write('h.alan:1: error: x\\n'); process.exit(3)"], { timeoutMs: 10000 });
    assert.equal(r.code, 3);
    assert.equal(r.stderr, "h.alan:1: error: x\n");
    assert.equal(r.failure, undefined);
  });
  it("reports a timeout", async () => {
    const r = await runCompiler(node, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 200 });
    assert.equal(r.failure, "timeout");
  });
  it("reports a missing program", async () => {
    const r = await runCompiler("no-such-alanc-here", [], { timeoutMs: 1000 });
    assert.equal(r.failure, "missing");
  });
  it("reports too much output as an error, not a timeout", async () => {
    const r = await runCompiler(node, ["-e", "process.stdout.write('x'.repeat(4096))"], { timeoutMs: 10000, maxBuffer: 100 });
    assert.equal(r.failure, "error");
    assert.match(r.detail ?? "", /too large/);
  });
  it("kills the process when aborted", async () => {
    const abort = new AbortController();
    const started = Date.now();
    const run = runCompiler(node, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 10000, signal: abort.signal });
    setTimeout(() => abort.abort(), 100);
    const r = await run;
    assert.equal(r.failure, "aborted");
    assert.ok(Date.now() - started < 4000);
  });
});

describe("runCompiler stopping the compiler's children", () => {
  const node = process.execPath;
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "alan-tree-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /** Starts a compiler stand-in whose own child writes its pid to a file, like alanc running zig. */
  function startTree(opts: { timeoutMs: number; signal?: AbortSignal }) {
    const pidFile = path.join(dir, "child.pid");
    const grandchild = `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30000)`;
    // Node puts its own children in a Windows job that dies with it, which
    // zig under alanc is not. detached keeps the child out of that job there.
    const detached = process.platform === "win32";
    const parent = `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore", detached: ${detached} }); setTimeout(() => {}, 30000)`;
    return { pidFile, run: runCompiler(node, ["-e", parent], opts) };
  }

  async function waitFor(test: () => boolean, ms: number): Promise<boolean> {
    for (const end = Date.now() + ms; Date.now() < end;) {
      if (test()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return test();
  }

  it("leaves no child running after an abort", async () => {
    const abort = new AbortController();
    const { pidFile, run } = startTree({ timeoutMs: 20000, signal: abort.signal });
    assert.ok(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "", 8000), "the child started");
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(alive(pid));
    abort.abort();
    const r = await run;
    assert.equal(r.failure, "aborted");
    assert.ok(await waitFor(() => !alive(pid), 3000), "the child is gone");
  });

  it("leaves no child running after a timeout", async () => {
    const { pidFile, run } = startTree({ timeoutMs: 3000 });
    const r = await run;
    assert.equal(r.failure, "timeout");
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(await waitFor(() => !alive(pid), 3000), "the child is gone");
  });
});

describe("the WSL wrapper on Windows", function () {
  this.timeout(60000);
  const wslExe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wsl.exe");

  before(function () {
    if (process.platform !== "win32" || !existsSync(wslExe)) this.skip();
    // CI runners have wsl.exe but no Linux distribution to run.
    if (spawnSync(wslExe, ["-e", "true"], { timeout: 30000 }).status !== 0) this.skip();
  });

  it("hands hostile arguments to the Linux program byte for byte", async () => {
    const hostile = [
      "a b", "  two  spaces ", "Σάββας", "$HOME", "${PATH}", "q\"uote", "it's", "`id`", "$(id)", "a;b|c&d>e",
      "line1\nline2", "trail\\", "back\\\"slash", "*.alan", "~", "", "-O",
    ];
    // commandLine puts exactly this in front of the compiler and its arguments.
    const prefix = commandLine({ exe: "printf", wsl: true }, "check", "/x.alan", { optimize: false }).args.slice(0, 4);
    assert.deepEqual(prefix, ["-e", "sh", "-c", WSL_LAUNCH]);
    const r = await runCompiler("wsl.exe", [...prefix, "printf", "%s\\0", ...hostile], { timeoutMs: 50000 });
    assert.equal(r.failure, undefined, r.detail);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.stdout.split("\0").slice(0, -1), hostile);
  });
});
