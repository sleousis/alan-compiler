import { strict as assert } from "assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import {
  assetName, extractArchive, GITHUB, hostArch, install, installedCompilerPath, installedTag, isOlderTag, latestCompilerTag,
  MIN_COMPILER, platformId, redirectAllowed, ReleaseSource, uninstall, wslInstallCommand, wslUninstallCommand,
} from "../../src/client/installer";

const FIXTURES = path.join(__dirname, "..", "fixtures", "fake-release");
// Windows can hold a file open for a moment after a download or unpack ends.
const RM_RETRY = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };

/** Serves the files of FIXTURES, or the bodies of routes first, on 127.0.0.1. */
function serve(routes: Map<string, Buffer> = new Map()): Promise<{ base: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
    hits.push(url);
    if (url === "/redirect/releases.json") {
      res.writeHead(302, { Location: "/releases.json" });
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
      resolve({
        base, hits, close: () => new Promise((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
      });
    });
  });
}

function source(base: string, dir = ""): ReleaseSource {
  return { apiReleases: `${base}${dir}/releases.json`, download: (tag, asset) => `${base}${dir}/${tag}/${asset}` };
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** A ustar header for a regular file. */
function tarHeader(name: string, size: number): Buffer {
  const h = Buffer.alloc(512);
  const put = (text: string, at: number) => h.write(text, at, "ascii");
  put(name, 0);
  put("0000644\0", 100);
  put("0000000\0", 108);
  put("0000000\0", 116);
  put(size.toString(8).padStart(11, "0") + "\0", 124);
  put("00000000000\0", 136);
  put("        ", 148);
  put("0", 156);
  put("ustar\0", 257);
  put("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

/** A tar.gz with one file of size zero bytes under alan/. */
function zerosTarGz(size: number): Buffer {
  const pad = (512 - (size % 512)) % 512;
  return gzipSync(Buffer.concat([tarHeader("alan/zeros", size), Buffer.alloc(size + pad), Buffer.alloc(1024)]));
}
const here = { platform: process.platform, arch: process.arch };
const ext = process.platform === "win32" ? "zip" : "tar.gz";

describe("installer", () => {
  let tmp: string;
  let srv: Awaited<ReturnType<typeof serve>>;
  let fake: ReleaseSource;
  // Aborted after each test, so an install still running after a timeout
  // stops before the folder is removed.
  let ac: AbortController;
  const installHere = (dir: string, src: ReleaseSource, platform: NodeJS.Platform, arch: string,
    progress?: (msg: string, pct: number) => void) => install(dir, src, platform, arch, progress, ac.signal);

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alan-install-"));
    ac = new AbortController();
    srv = await serve();
    fake = source(srv.base);
  });
  afterEach(async () => {
    ac.abort();
    await srv.close();
    fs.rmSync(tmp, RM_RETRY);
  });

  it("installs, finds and removes the compiler", async () => {
    const r = await installHere(tmp, fake, process.platform, process.arch);
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
    const r = await installHere(tmp, fake, here.platform, here.arch);
    const exe = process.platform === "win32" ? "alanc.exe" : "alanc";
    assert.equal(r.alanc, path.join(tmp, "alan", "bin", exe));
    assert.match(fs.readFileSync(r.alanc, "utf8"), /^fake alanc for /);
    if (process.platform !== "win32") assert.ok(fs.statSync(r.alanc).mode & 0o100, "alanc is executable");
  });

  it("replaces an older copy and keeps nothing of it", async () => {
    fs.mkdirSync(path.join(tmp, "alan", "bin"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "alan", "stale.txt"), "old");
    fs.writeFileSync(path.join(tmp, "alan", "VERSION"), "v1.9.0\n");
    const r = await installHere(tmp, fake, here.platform, here.arch);
    assert.equal(installedTag(tmp), "v2.0.0");
    assert.ok(!fs.existsSync(path.join(tmp, "alan", "stale.txt")));
    assert.ok(fs.existsSync(r.alanc));
    assert.deepEqual(fs.readdirSync(tmp), ["alan"]);
  });

  it("creates a storage folder that does not exist yet", async () => {
    const deep = path.join(tmp, "not", "there");
    const r = await installHere(deep, fake, here.platform, here.arch);
    assert.ok(fs.existsSync(r.alanc));
  });

  it("reports progress from 0 to 100", async () => {
    const seen: number[] = [];
    await installHere(tmp, fake, here.platform, here.arch, (msg, pct) => {
      assert.ok(msg.length > 0);
      seen.push(pct);
    });
    assert.equal(seen[0], 0);
    assert.equal(seen[seen.length - 1], 100);
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], `progress went back at ${i}: ${seen}`);
  });

  it("follows redirects", async () => {
    const r = await installHere(tmp, { ...fake, apiReleases: `${srv.base}/redirect/releases.json` }, here.platform, here.arch);
    assert.equal(r.tag, "v2.0.0");
  });

  it("leaves nothing behind on a checksum mismatch", async () => {
    const asset = assetName("v2.0.0", here.platform, here.arch);
    const bad = new Map([["/bad/v2.0.0/SHA256SUMS", Buffer.from(`${"0".repeat(64)}  ${asset}\n`)]]);
    await srv.close();
    srv = await serve(bad);
    const fakeCorrupt: ReleaseSource = {
      apiReleases: `${srv.base}/releases.json`,
      download: (tag, a) => `${srv.base}${a === "SHA256SUMS" ? "/bad" : ""}/${tag}/${a}`,
    };
    await assert.rejects(installHere(tmp, fakeCorrupt, process.platform, process.arch),
      { message: "The download did not match its checksum. Nothing was installed." });
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

  it("keeps the old copy when the new one fails", async () => {
    await installHere(tmp, fake, here.platform, here.arch);
    const asset = assetName("v2.0.0", here.platform, here.arch);
    await srv.close();
    srv = await serve(new Map([["/v2.0.0/SHA256SUMS", Buffer.from(`${"1".repeat(64)}  ${asset}\n`)]]));
    await assert.rejects(installHere(tmp, source(srv.base), here.platform, here.arch), /checksum/);
    assert.deepEqual(fs.readdirSync(tmp), ["alan"]);
    assert.equal(installedTag(tmp), "v2.0.0");
  });

  it("fails clearly when offline", async () => {
    await srv.close();
    const unreachable = source(srv.base);
    await assert.rejects(installHere(tmp, unreachable, process.platform, process.arch),
      { message: "Could not reach GitHub. Check your connection and try again." });
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

  it("fails clearly when a download breaks off", async () => {
    const asset = assetName("v2.0.0", here.platform, here.arch);
    const server = http.createServer((req, res) => {
      if (req.url === "/releases.json") {
        res.end('[{"tag_name":"v2.0.0"}]');
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
      await assert.rejects(installHere(tmp, source(base), here.platform, here.arch), /Could not reach GitHub/);
      assert.deepEqual(fs.readdirSync(tmp), []);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("says there is no release for this platform when the release lacks SHA256SUMS", async () => {
    await srv.close();
    srv = await serve(new Map([["/bare/releases.json", Buffer.from('[{"tag_name":"v2.0.1"}]')]]));
    await assert.rejects(installHere(tmp, source(srv.base, "/bare"), here.platform, here.arch),
      { message: "No Alan release for this platform." });
    assert.ok(srv.hits.includes("/bare/v2.0.1/SHA256SUMS"));
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

  it("says there is no compatible release yet when the latest is older than MIN_COMPILER", async () => {
    // Like GitHub today: v1.0.0 has no bundles.
    await srv.close();
    srv = await serve(new Map([["/old/releases.json", Buffer.from('[{"tag_name":"v1.0.0"}]')]]));
    await assert.rejects(installHere(tmp, source(srv.base, "/old"), here.platform, here.arch),
      { message: "No compatible Alan release yet. The extension needs v2.0.0 or later." });
    assert.deepEqual(srv.hits, ["/old/releases.json"]);
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

  it("says there is no release for this platform when SHA256SUMS does not list it", async () => {
    await srv.close();
    srv = await serve(new Map([
      ["/other/releases.json", Buffer.from('[{"tag_name":"v2.0.0"}]')],
      ["/other/v2.0.0/SHA256SUMS", Buffer.from(`${"3".repeat(64)}  alan-v2.0.0-plan9-x64.tar.gz\n`)],
    ]));
    await assert.rejects(installHere(tmp, source(srv.base, "/other"), here.platform, here.arch),
      { message: "No Alan release for this platform." });
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

  it("refuses an unsupported platform before downloading anything", async () => {
    await assert.rejects(installHere(tmp, fake, "sunos", "x64"), { message: "No Alan release for this platform." });
    assert.deepEqual(srv.hits, []);
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

  it("refuses a tag that is not a version", async () => {
    await srv.close();
    srv = await serve(new Map([["/weird/releases.json", Buffer.from('[{"tag_name":"../../x"}]')]]));
    await assert.rejects(installHere(tmp, source(srv.base, "/weird"), here.platform, here.arch), /release/);
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

  it("installs the newest compiler release when an extension release is the latest", async () => {
    // The fixture list starts with vscode-v1.0.0 and a v2.1.0-rc1 prerelease.
    const r = await installHere(tmp, fake, here.platform, here.arch);
    assert.equal(r.tag, "v2.0.0");
    assert.ok(!srv.hits.some((h) => h.includes("vscode-v1.0.0") || h.includes("v2.1.0-rc1")), srv.hits.join(" "));
  });

  it("skips drafts and prereleases", async () => {
    await srv.close();
    srv = await serve(new Map([["/mixed/releases.json", Buffer.from(JSON.stringify([
      { tag_name: "v3.0.0", draft: true, prerelease: false },
      { tag_name: "v2.9.0", draft: false, prerelease: true },
      { tag_name: "v2.0.1", draft: false, prerelease: false },
    ]))]]));
    await assert.rejects(installHere(tmp, source(srv.base, "/mixed"), here.platform, here.arch),
      { message: "No Alan release for this platform." });
    assert.deepEqual(srv.hits, ["/mixed/releases.json", "/mixed/v2.0.1/SHA256SUMS"]);
  });

  it("says clearly that there is no compiler release when the list has only extension releases", async () => {
    await srv.close();
    srv = await serve(new Map([["/ext/releases.json", Buffer.from(JSON.stringify([
      { tag_name: "vscode-v1.1.0", draft: false, prerelease: false },
      { tag_name: "vscode-v1.0.0", draft: false, prerelease: false },
    ]))]]));
    await assert.rejects(installHere(tmp, source(srv.base, "/ext"), here.platform, here.arch),
      { message: "GitHub lists no Alan compiler release. Try again later." });
    assert.deepEqual(srv.hits, ["/ext/releases.json"]);
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

  it("refuses an answer that is not a list", async () => {
    await srv.close();
    srv = await serve(new Map([["/obj/releases.json", Buffer.from('{"tag_name":"v2.0.0"}')]]));
    await assert.rejects(installHere(tmp, source(srv.base, "/obj"), here.platform, here.arch),
      { message: "GitHub did not send a valid list of Alan releases. Try again later." });
  });

  it("names the newest compiler release for a WSL install", async () => {
    assert.equal(await latestCompilerTag(fake, ac.signal), "v2.0.0");
    await srv.close();
    srv = await serve(new Map([["/old/releases.json", Buffer.from('[{"tag_name":"v1.0.0"}]')]]));
    await assert.rejects(latestCompilerTag(source(srv.base, "/old"), ac.signal),
      { message: "No compatible Alan release yet. The extension needs v2.0.0 or later." });
    await srv.close();
    await assert.rejects(latestCompilerTag(source(srv.base), ac.signal),
      { message: "Could not reach GitHub. Check your connection and try again." });
  });

  it("explains an HTTP error from GitHub", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(403);
      res.end("rate limited");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await assert.rejects(installHere(tmp, source(base), here.platform, here.arch), /GitHub answered with HTTP 403/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("stops and cleans up when cancelled", async () => {
    const cancel = new AbortController();
    cancel.abort();
    await assert.rejects(install(tmp, fake, here.platform, here.arch, undefined, cancel.signal), /cancelled/);
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
    await assert.rejects(installHere(tmp, source(srv.base), here.platform, here.arch), /unsafe path/);
    assert.deepEqual(fs.readdirSync(tmp), []);
    assert.ok(!fs.existsSync(path.join(tmp, "..", "escaped.txt")));
  });

  it("refuses a download larger than the limit before reading it", async () => {
    const asset = assetName("v2.0.0", here.platform, here.arch);
    const server = http.createServer((req, res) => {
      if (req.url === "/releases.json") {
        res.end('[{"tag_name":"v2.0.0"}]');
      } else if (req.url === "/v2.0.0/SHA256SUMS") {
        res.end(`${"4".repeat(64)}  ${asset}\n`);
      } else {
        res.writeHead(200, { "Content-Length": 5 * 1024 * 1024 * 1024 });
        res.write(Buffer.alloc(1000));
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await assert.rejects(installHere(tmp, source(base), here.platform, here.arch),
        { message: "The download is too large or unsafe. Nothing was installed." });
      assert.deepEqual(fs.readdirSync(tmp), []);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  it("stops a download without Content-Length once it passes the limit", async () => {
    const asset = assetName("v2.0.0", here.platform, here.arch);
    let sent = 0;
    const server = http.createServer((req, res) => {
      if (req.url === "/releases.json") {
        res.end('[{"tag_name":"v2.0.0"}]');
      } else if (req.url === "/v2.0.0/SHA256SUMS") {
        res.end(`${"5".repeat(64)}  ${asset}
`);
      } else {
        // Chunked, so there is no Content-Length to check first.
        res.writeHead(200);
        const more = () => {
          if (res.destroyed || sent >= 64 * 1024 * 1024) return void res.end();
          sent += 64 * 1024;
          if (res.write(Buffer.alloc(64 * 1024))) setImmediate(more);
          else res.once("drain", more);
        };
        more();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await assert.rejects(installHere(tmp, { ...source(base), maxDownload: 300 * 1024 }, here.platform, here.arch),
        { message: "The download is too large or unsafe. Nothing was installed." });
      assert.deepEqual(fs.readdirSync(tmp), []);
      assert.ok(sent < 64 * 1024 * 1024, `the server sent all ${sent} bytes`);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  it("puts back a copy that a failed swap left as alan.old", async () => {
    await installHere(tmp, fake, here.platform, here.arch);
    fs.renameSync(path.join(tmp, "alan"), path.join(tmp, "alan.old"));
    // An install that fails still keeps the copy.
    await srv.close();
    await assert.rejects(installHere(tmp, fake, here.platform, here.arch), /Could not reach/);
    assert.deepEqual(fs.readdirSync(tmp), ["alan"]);
    assert.equal(installedTag(tmp), "v2.0.0");
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
  afterEach(() => fs.rmSync(tmp, RM_RETRY));

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
          /unsafe path|unsafe link/);
        assert.ok(!fs.existsSync(path.join(tmp, "escaped.txt")));
        assert.ok(!fs.existsSync(path.join(tmp, "inner", "escaped.txt")));
        assert.ok(!fs.existsSync(path.join(tmp, "escaped")));
        assert.ok(!fs.existsSync(path.join(dest, "link")));
      });
    }
  }

  /** Every path below root, and whether it is a link. */
  function walk(root: string): { p: string; link: boolean }[] {
    const out: { p: string; link: boolean }[] = [];
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      const p = path.join(root, e.name);
      out.push({ p, link: e.isSymbolicLink() });
      if (e.isDirectory()) out.push(...walk(p));
    }
    return out;
  }

  // The bundles hold no links, so every symbolic or hard link fails the archive.
  const links: [string, string][] = [
    ["symlink.tar.gz", "alan/link"],
    ["hardlink.tar.gz", "alan/passwd"],
    ["inside-link.tar.gz", "alan/bin/zig"],
    ["inside-hardlink.tar.gz", "alan/bin/alanc"],
    ["chain.tar.gz", "alan/a/b/s"],
    ["updown.tar.gz", "alan/a/b/c/l1"],
    ["ancestor1.tar.gz", "alan/a/b/c/c2/d/l1"],
    ["ancestor2.tar.gz", "alan/a/b/c/l1"],
  ];
  for (const [fixture, first] of links) {
    it(`refuses every link: ${fixture}`, async () => {
      // Several runs, since the review's archives raced parallel writes.
      for (let run = 0; run < 5; run++) {
        fs.rmSync(dest, { recursive: true, force: true });
        fs.mkdirSync(dest);
        await assert.rejects(extractArchive(path.join(FIXTURES, "evil", fixture), dest, "tar.gz"),
          { message: `The download holds an unsafe link (${first}). Nothing was installed.` });
        const all = walk(tmp);
        assert.deepEqual(all.filter((e) => e.link), []);
        assert.deepEqual(all.filter((e) => !e.p.startsWith(path.join(tmp, "inner"))), []);
        assert.ok(!all.some((e) => /pwned|escaped|passwd/.test(e.p)));
      }
    });
  }

  it("fails and does not hang on broken compressed data", async () => {
    const good = gzipSync(Buffer.concat([tarHeader("alan/bin/alanc", 70000), Buffer.alloc(70000 + 144, 65),
      Buffer.alloc(1024)]));
    const bad = Buffer.from(good);
    for (let i = 20; i < 40; i++) bad[i] ^= 0x5a;
    const file = path.join(tmp, "bad.tar.gz");
    fs.writeFileSync(file, bad);
    await assert.rejects(extractArchive(file, dest, "tar.gz"), /could not be unpacked/);
  });

  it("fails and does not hang on data that expands too much", async () => {
    const file = path.join(tmp, "bomb.tar.gz");
    fs.writeFileSync(file, zerosTarGz(50 * 1024 * 1024));
    await assert.rejects(extractArchive(file, dest, "tar.gz"),
      { message: "The download is too large or unsafe. Nothing was installed." });
  });

  for (const kind of ["zip", "tar.gz"] as const) {
    const name = kind === "zip" ? "alan-v2.0.0-windows-x64.zip" : "alan-v2.0.0-linux-x64.tar.gz";
    it(`stops a ${kind} with more entries than allowed`, async () => {
      await assert.rejects(extractArchive(path.join(FIXTURES, "v2.0.0", name), dest, kind, undefined, undefined,
        { bytes: 1e9, entries: 2 }), { message: "The download is too large or unsafe. Nothing was installed." });
    });
    it(`stops a ${kind} that unpacks to more bytes than allowed`, async () => {
      await assert.rejects(extractArchive(path.join(FIXTURES, "v2.0.0", name), dest, kind, undefined, undefined,
        { bytes: 10, entries: 100 }), { message: "The download is too large or unsafe. Nothing was installed." });
    });
  }

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
  it("installs for the machine's CPU when VS Code runs emulated", async () => {
    const asked: string[][] = [];
    /** Answers reg query with the machine value given, and sysctl with translated. */
    const fake = (machine: string, translated = "") => async (cmd: string, args: string[]) => {
      asked.push([cmd, ...args]);
      if (cmd === "reg") return machine && `\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n    PROCESSOR_ARCHITECTURE    REG_SZ    ${machine}\r\n\r\n`;
      if (cmd === "sysctl") return translated;
      throw new Error(`unexpected ${cmd}`);
    };
    // Windows: x64 VS Code emulated on ARM64 sees AMD64, and the registry tells.
    assert.equal(await hostArch("win32", "x64", { PROCESSOR_ARCHITECTURE: "AMD64" }, fake("ARM64")), "arm64");
    assert.deepEqual(asked[0], ["reg", "query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
      "/v", "PROCESSOR_ARCHITECTURE"]);
    assert.equal(await hostArch("win32", "x64", { PROCESSOR_ARCHITECTURE: "AMD64" }, fake("AMD64")), "x64");
    // Without an answer from reg the process's own values decide.
    assert.equal(await hostArch("win32", "x64", { PROCESSOR_ARCHITECTURE: "ARM64" }, fake("")), "arm64");
    assert.equal(await hostArch("win32", "x64", { PROCESSOR_ARCHITEW6432: "ARM64", PROCESSOR_ARCHITECTURE: "x86" }, fake("")),
      "arm64");
    assert.equal(await hostArch("win32", "x64", { PROCESSOR_ARCHITEW6432: "AMD64", PROCESSOR_ARCHITECTURE: "ARM64" }, fake("")),
      "x64");
    assert.equal(await hostArch("win32", "x64", {}, fake("")), "x64");
    assert.equal(await hostArch("win32", "arm64", { PROCESSOR_ARCHITECTURE: "ARM64" }, fake("ARM64")), "arm64");
    // macOS: sysctl.proc_translated is 1 under Rosetta.
    assert.equal(await hostArch("darwin", "x64", {}, fake("", "1\n")), "arm64");
    assert.equal(await hostArch("darwin", "x64", {}, fake("", "0\n")), "x64");
    assert.equal(await hostArch("darwin", "x64", {}, fake("", "")), "x64", "an Intel Mac has no such sysctl");
    // An arm64 Mac and Linux ask nothing.
    asked.length = 0;
    assert.equal(await hostArch("darwin", "arm64", {}, fake("")), "arm64");
    assert.equal(await hostArch("linux", "x64", { PROCESSOR_ARCHITECTURE: "ARM64" }, fake("ARM64")), "x64");
    assert.deepEqual(asked, []);
  });
  it("finds this machine's CPU", async () => {
    const arch = await hostArch(process.platform, process.arch, process.env);
    assert.ok(arch === "x64" || arch === "arm64", arch);
    // Not emulated (the test runners): the answer is the process's own CPU.
    if (process.platform !== "darwin" || process.arch === "arm64") assert.equal(arch, process.arch);
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
    assert.equal(GITHUB.apiReleases, "https://api.github.com/repos/sleousis/alan-compiler/releases?per_page=100");
    assert.equal(GITHUB.download("v2.0.0", "SHA256SUMS"),
      "https://github.com/sleousis/alan-compiler/releases/download/v2.0.0/SHA256SUMS");
  });
  it("never follows a redirect from https to http", () => {
    const u = (s: string) => new URL(s);
    assert.ok(redirectAllowed(u("https://github.com/a"), u("https://objects.githubusercontent.com/b")));
    assert.ok(redirectAllowed(u("http://127.0.0.1/a"), u("http://127.0.0.1/b")));
    assert.ok(redirectAllowed(u("http://127.0.0.1/a"), u("https://example.com/b")));
    assert.ok(!redirectAllowed(u("https://github.com/a"), u("http://github.com/b")));
    assert.ok(!redirectAllowed(u("https://github.com/a"), u("file:///etc/passwd")));
    assert.ok(!redirectAllowed(u("http://127.0.0.1/a"), u("ftp://example.com/b")));
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
  it("runs the install.sh of the tag being installed, with argument arrays", () => {
    const c = wslInstallCommand("v2.1.0");
    assert.equal(c.cmd, "wsl.exe");
    assert.deepEqual(c.args.slice(0, 3), ["-e", "sh", "-c"]);
    assert.equal(c.args[4], "https://raw.githubusercontent.com/sleousis/alan-compiler/v2.1.0/install/install.sh");
    assert.equal(c.args[5], "v2.1.0");
    assert.equal(c.args.length, 6);
    assert.ok(!c.args[3].includes("https://"), "the URL is an argument, not part of the script");
    assert.ok(!c.args[3].includes("v2.1.0"), "the tag is an argument, not part of the script");
    assert.match(c.args[3], /ALAN_VERSION="\$1" sh "\$t"/, "install.sh gets the same tag");
  });
  it("hands the tag to install.sh as ALAN_VERSION", async function () {
    if (process.platform === "win32") this.skip();
    // The script with sh itself, a local install.sh and a curl that copies it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alan-wsl-"));
    try {
      fs.writeFileSync(path.join(dir, "install.sh"), 'echo "version=$ALAN_VERSION"\n');
      fs.writeFileSync(path.join(dir, "curl"), '#!/bin/sh\n# curl -fsSL <url> -o <file>\ncp "$2" "$4"\n', { mode: 0o755 });
      const c = wslInstallCommand("v2.1.0");
      const args = [...c.args.slice(3, 4), path.join(dir, "install.sh"), c.args[5]];
      const r = spawnSync("sh", ["-c", ...args], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), "version=v2.1.0");
    } finally {
      fs.rmSync(dir, RM_RETRY);
    }
  });
  it("removes the WSL copy with a fixed script", () => {
    const c = wslUninstallCommand();
    assert.equal(c.cmd, "wsl.exe");
    assert.deepEqual(c.args.slice(0, 3), ["-e", "sh", "-c"]);
    assert.equal(c.args.length, 4);
    assert.match(c.args[3], /\.local\/share\/alan/);
  });
});
