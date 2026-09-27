import { strict as assert } from "assert";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  assetName, extractArchive, GITHUB, install, installedCompilerPath, installedTag, isOlderTag, MIN_COMPILER, platformId,
  ReleaseSource, uninstall, wslInstallCommand, wslUninstallCommand,
} from "../../src/client/installer";

const FIXTURES = path.join(__dirname, "..", "fixtures", "fake-release");

/** Serves the files of FIXTURES, or the bodies of routes first, on 127.0.0.1. */
function serve(routes: Map<string, Buffer> = new Map()): Promise<{ base: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
    hits.push(url);
    if (url === "/redirect/latest.json") {
      res.writeHead(302, { Location: "/latest.json" });
      res.end();
      return;
    }
    let body = routes.get(url);
    if (!body) {
      const file = path.join(FIXTURES, ...url.split("/").filter((s) => s && s !== ".."));
      if (fs.existsSync(file) && fs.statSync(file).isFile()) body = fs.readFileSync(file);
    }
    if (!body) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    res.writeHead(200, { "Content-Length": body.length });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve({ base, hits, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function source(base: string, dir = ""): ReleaseSource {
  return { apiLatest: `${base}${dir}/latest.json`, download: (tag, asset) => `${base}${dir}/${tag}/${asset}` };
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const here = { platform: process.platform, arch: process.arch };
const ext = process.platform === "win32" ? "zip" : "tar.gz";

describe("installer", () => {
  let tmp: string;
  let srv: Awaited<ReturnType<typeof serve>>;
  let fake: ReleaseSource;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alan-install-"));
    srv = await serve();
    fake = source(srv.base);
  });
  afterEach(async () => {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("installs, finds and removes the compiler", async () => {
    const r = await install(tmp, fake, process.platform, process.arch);
    assert.equal(r.tag, "v2.0.0");
    assert.ok(fs.existsSync(r.alanc));
    assert.equal(installedCompilerPath(tmp, process.platform), r.alanc);
    assert.equal(installedTag(tmp), "v2.0.0");
    assert.deepEqual(fs.readdirSync(tmp), ["alan"]);
    await uninstall(tmp);
    assert.equal(installedCompilerPath(tmp, process.platform), undefined);
    assert.equal(installedTag(tmp), undefined);
  });

  it("puts the compiler at alan/bin/alanc inside the storage folder", async () => {
    const r = await install(tmp, fake, here.platform, here.arch);
    const exe = process.platform === "win32" ? "alanc.exe" : "alanc";
    assert.equal(r.alanc, path.join(tmp, "alan", "bin", exe));
    assert.match(fs.readFileSync(r.alanc, "utf8"), /^fake alanc for /);
    if (process.platform !== "win32") assert.ok(fs.statSync(r.alanc).mode & 0o100, "alanc is executable");
  });

  it("replaces an older copy and keeps nothing of it", async () => {
    fs.mkdirSync(path.join(tmp, "alan", "bin"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "alan", "stale.txt"), "old");
    fs.writeFileSync(path.join(tmp, "alan", "VERSION"), "v1.9.0\n");
    const r = await install(tmp, fake, here.platform, here.arch);
    assert.equal(installedTag(tmp), "v2.0.0");
    assert.ok(!fs.existsSync(path.join(tmp, "alan", "stale.txt")));
    assert.ok(fs.existsSync(r.alanc));
    assert.deepEqual(fs.readdirSync(tmp), ["alan"]);
  });

  it("creates a storage folder that does not exist yet", async () => {
    const deep = path.join(tmp, "not", "there");
    const r = await install(deep, fake, here.platform, here.arch);
    assert.ok(fs.existsSync(r.alanc));
  });

  it("reports progress from 0 to 100", async () => {
    const seen: number[] = [];
    await install(tmp, fake, here.platform, here.arch, (msg, pct) => {
      assert.ok(msg.length > 0);
      seen.push(pct);
    });
    assert.equal(seen[0], 0);
    assert.equal(seen[seen.length - 1], 100);
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], `progress went back at ${i}: ${seen}`);
  });

  it("follows redirects", async () => {
    const r = await install(tmp, { ...fake, apiLatest: `${srv.base}/redirect/latest.json` }, here.platform, here.arch);
    assert.equal(r.tag, "v2.0.0");
  });

  it("leaves nothing behind on a checksum mismatch", async () => {
    const asset = assetName("v2.0.0", here.platform, here.arch);
    const bad = new Map([["/bad/v2.0.0/SHA256SUMS", Buffer.from(`${"0".repeat(64)}  ${asset}\n`)]]);
    await srv.close();
    srv = await serve(bad);
    const fakeCorrupt: ReleaseSource = {
      apiLatest: `${srv.base}/latest.json`,
      download: (tag, a) => `${srv.base}${a === "SHA256SUMS" ? "/bad" : ""}/${tag}/${a}`,
    };
    await assert.rejects(install(tmp, fakeCorrupt, process.platform, process.arch),
      { message: "The download did not match its checksum. Nothing was installed." });
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

  it("keeps the old copy when the new one fails", async () => {
    await install(tmp, fake, here.platform, here.arch);
    const asset = assetName("v2.0.0", here.platform, here.arch);
    await srv.close();
    srv = await serve(new Map([["/v2.0.0/SHA256SUMS", Buffer.from(`${"1".repeat(64)}  ${asset}\n`)]]));
    await assert.rejects(install(tmp, source(srv.base), here.platform, here.arch), /checksum/);
    assert.deepEqual(fs.readdirSync(tmp), ["alan"]);
    assert.equal(installedTag(tmp), "v2.0.0");
  });

  it("fails clearly when offline", async () => {
    await srv.close();
    const unreachable = source(srv.base);
    await assert.rejects(install(tmp, unreachable, process.platform, process.arch),
      { message: "Could not reach GitHub. Check your connection and try again." });
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

  it("fails clearly when a download breaks off", async () => {
    const asset = assetName("v2.0.0", here.platform, here.arch);
    const server = http.createServer((req, res) => {
      if (req.url === "/latest.json") {
        res.end('{"tag_name":"v2.0.0"}');
      } else if (req.url === "/v2.0.0/SHA256SUMS") {
        res.end(`${"2".repeat(64)}  ${asset}\n`);
      } else {
        res.writeHead(200, { "Content-Length": 100000 });
        res.write(Buffer.alloc(1000));
        setTimeout(() => res.destroy(), 20);
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await assert.rejects(install(tmp, source(base), here.platform, here.arch), /Could not reach GitHub/);
      assert.deepEqual(fs.readdirSync(tmp), []);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("says there is no release for this platform when the release lacks SHA256SUMS", async () => {
    await srv.close();
    srv = await serve(new Map([["/bare/latest.json", Buffer.from('{"tag_name":"v2.0.1"}')]]));
    await assert.rejects(install(tmp, source(srv.base, "/bare"), here.platform, here.arch),
      { message: "No Alan release for this platform." });
    assert.ok(srv.hits.includes("/bare/v2.0.1/SHA256SUMS"));
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

  it("says there is no release for this platform when the latest is older than MIN_COMPILER", async () => {
    // Like GitHub today: v1.0.0 has no bundles.
    await srv.close();
    srv = await serve(new Map([["/old/latest.json", Buffer.from('{"tag_name":"v1.0.0"}')]]));
    await assert.rejects(install(tmp, source(srv.base, "/old"), here.platform, here.arch),
      { message: "No Alan release for this platform." });
    assert.deepEqual(srv.hits, ["/old/latest.json"]);
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

  it("says there is no release for this platform when SHA256SUMS does not list it", async () => {
    await srv.close();
    srv = await serve(new Map([
      ["/other/latest.json", Buffer.from('{"tag_name":"v2.0.0"}')],
      ["/other/v2.0.0/SHA256SUMS", Buffer.from(`${"3".repeat(64)}  alan-v2.0.0-plan9-x64.tar.gz\n`)],
    ]));
    await assert.rejects(install(tmp, source(srv.base, "/other"), here.platform, here.arch),
      { message: "No Alan release for this platform." });
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

  it("refuses an unsupported platform before downloading anything", async () => {
    await assert.rejects(install(tmp, fake, "sunos", "x64"), { message: "No Alan release for this platform." });
    assert.deepEqual(srv.hits, []);
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

  it("refuses a tag that is not a version", async () => {
    await srv.close();
    srv = await serve(new Map([["/weird/latest.json", Buffer.from('{"tag_name":"../../x"}')]]));
    await assert.rejects(install(tmp, source(srv.base, "/weird"), here.platform, here.arch), /release/);
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

  it("explains an HTTP error from GitHub", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(403);
      res.end("rate limited");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await assert.rejects(install(tmp, source(base), here.platform, here.arch), /GitHub answered with HTTP 403/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("stops and cleans up when cancelled", async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(install(tmp, fake, here.platform, here.arch, undefined, ac.signal), /cancelled/);
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

  it("rejects a bundle that escapes its folder and leaves nothing behind", async () => {
    const evil = fs.readFileSync(path.join(FIXTURES, "evil", `dotdot.${ext}`));
    const asset = assetName("v2.0.0", here.platform, here.arch);
    await srv.close();
    srv = await serve(new Map([
      ["/v2.0.0/SHA256SUMS", Buffer.from(`${sha256(evil)}  ${asset}\n`)],
      [`/v2.0.0/${asset}`, evil],
    ]));
    await assert.rejects(install(tmp, source(srv.base), here.platform, here.arch), /unsafe path/);
    assert.deepEqual(fs.readdirSync(tmp), []);
    assert.ok(!fs.existsSync(path.join(tmp, "..", "escaped.txt")));
  });

  it("uninstall is fine when nothing is installed", async () => {
    await uninstall(tmp);
    await uninstall(path.join(tmp, "missing"));
    assert.deepEqual(fs.readdirSync(tmp), []);
  });
});

describe("extractArchive", () => {
  let tmp: string;
  let dest: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alan-extract-"));
    dest = path.join(tmp, "inner", "out");
    fs.mkdirSync(dest, { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  for (const kind of ["zip", "tar.gz"] as const) {
    it(`unpacks a ${kind} bundle without its alan/ folder`, async () => {
      const name = kind === "zip" ? "alan-v2.0.0-windows-x64.zip" : "alan-v2.0.0-linux-x64.tar.gz";
      const counts: number[] = [];
      await extractArchive(path.join(FIXTURES, "v2.0.0", name), dest, kind, (done, total) => counts.push(done / total));
      const exe = kind === "zip" ? "alanc.exe" : "alanc";
      assert.ok(fs.existsSync(path.join(dest, "bin", exe)));
      assert.equal(fs.readFileSync(path.join(dest, "VERSION"), "utf8"), "v2.0.0\n");
      assert.ok(counts.length > 0);
      assert.equal(counts[counts.length - 1], 1);
    });

    for (const evil of ["dotdot", "absolute", "symlink"]) {
      it(`rejects a ${kind} with a ${evil} entry`, async () => {
        await assert.rejects(extractArchive(path.join(FIXTURES, "evil", `${evil}.${kind}`), dest, kind),
          /unsafe path|link that is not allowed/);
        assert.ok(!fs.existsSync(path.join(tmp, "escaped.txt")));
        assert.ok(!fs.existsSync(path.join(tmp, "inner", "escaped.txt")));
        assert.ok(!fs.existsSync(path.join(tmp, "escaped")));
        assert.ok(!fs.existsSync(path.join(dest, "link")));
      });
    }
  }

  it("rejects a tar.gz with a hard link out of the folder", async () => {
    await assert.rejects(extractArchive(path.join(FIXTURES, "evil", "hardlink.tar.gz"), dest, "tar.gz"), /link that is not allowed/);
    assert.ok(!fs.existsSync(path.join(dest, "passwd")));
  });

  it("rejects a tar.gz whose links climb out through another link", async () => {
    await assert.rejects(extractArchive(path.join(FIXTURES, "evil", "chain.tar.gz"), dest, "tar.gz"),
      /link that is not allowed \(alan\/a\/b\/s\/u\)/);
    assert.ok(!fs.existsSync(path.join(tmp, "escaped")));
    assert.ok(!fs.existsSync(path.join(tmp, "inner", "escaped")));
  });

  // Windows needs a privilege to make symbolic links, and its bundles are zips without links.
  (process.platform === "win32" ? it.skip : it)("keeps a link that stays inside", async () => {
    await extractArchive(path.join(FIXTURES, "inner-link.tar.gz"), dest, "tar.gz");
    assert.equal(fs.readlinkSync(path.join(dest, "bin", "zig")), "../zig/zig");
    assert.equal(fs.readFileSync(path.join(dest, "bin", "zig"), "utf8"), "fine\n");
  });

  it("rejects a file that is not an archive", async () => {
    const junk = path.join(tmp, "junk");
    fs.writeFileSync(junk, "not an archive");
    await assert.rejects(extractArchive(junk, dest, "zip"));
    await assert.rejects(extractArchive(junk, dest, "tar.gz"));
  });
});

describe("release names", () => {
  it("maps platforms and CPUs to release platforms", () => {
    assert.equal(platformId("win32", "x64"), "windows-x64");
    assert.equal(platformId("win32", "arm64"), "windows-arm64");
    assert.equal(platformId("linux", "x64"), "linux-x64");
    assert.equal(platformId("linux", "arm64"), "linux-arm64");
    assert.equal(platformId("darwin", "x64"), "macos-x64");
    assert.equal(platformId("darwin", "arm64"), "macos-arm64");
  });
  it("throws for other platforms", () => {
    for (const [p, a] of [["win32", "ia32"], ["linux", "arm"], ["freebsd", "x64"], ["sunos", "x64"]] as const) {
      assert.throws(() => platformId(p, a), { message: "No Alan release for this platform." });
    }
  });
  it("names the assets", () => {
    assert.equal(assetName("v2.0.0", "win32", "x64"), "alan-v2.0.0-windows-x64.zip");
    assert.equal(assetName("v2.0.0", "darwin", "arm64"), "alan-v2.0.0-macos-arm64.tar.gz");
    assert.equal(assetName("v2.1.0", "linux", "x64"), "alan-v2.1.0-linux-x64.tar.gz");
  });
  it("points at the GitHub releases", () => {
    assert.equal(GITHUB.apiLatest, "https://api.github.com/repos/sleousis/alan-compiler/releases/latest");
    assert.equal(GITHUB.download("v2.0.0", "SHA256SUMS"),
      "https://github.com/sleousis/alan-compiler/releases/download/v2.0.0/SHA256SUMS");
  });
  it("compares tags", () => {
    assert.equal(MIN_COMPILER, "v2.0.0");
    assert.ok(isOlderTag("v1.0.0", MIN_COMPILER));
    assert.ok(isOlderTag("v1.99.99", "v2.0.0"));
    assert.ok(isOlderTag("v2.0.0-rc1", "v2.0.0"));
    assert.ok(isOlderTag("v2.0.9", "v2.0.10"));
    assert.ok(!isOlderTag("v2.0.0", MIN_COMPILER));
    assert.ok(!isOlderTag("v2.1.0", MIN_COMPILER));
    assert.ok(!isOlderTag("v10.0.0", "v9.0.0"));
    assert.ok(isOlderTag("dev", MIN_COMPILER), "a tag that is not a version counts as old");
  });
});

describe("WSL install", () => {
  it("runs install.sh inside WSL with argument arrays", () => {
    const c = wslInstallCommand();
    assert.equal(c.cmd, "wsl.exe");
    assert.deepEqual(c.args.slice(0, 3), ["-e", "sh", "-c"]);
    assert.equal(c.args[4], "https://raw.githubusercontent.com/sleousis/alan-compiler/master/install/install.sh");
    assert.equal(c.args.length, 5);
    assert.ok(!c.args[3].includes("https://"), "the URL is an argument, not part of the script");
  });
  it("removes the WSL copy with a fixed script", () => {
    const c = wslUninstallCommand();
    assert.equal(c.cmd, "wsl.exe");
    assert.deepEqual(c.args.slice(0, 3), ["-e", "sh", "-c"]);
    assert.equal(c.args.length, 4);
    assert.match(c.args[3], /\.local\/share\/alan/);
  });
});
