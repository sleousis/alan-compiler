// Downloads the Alan compiler bundle from the releases, checks its SHA-256,
// unpacks it into the extension's storage folder and removes it again. It
// needs no VS Code API, so the unit tests run it against a local server.
//
// Layout of the storage folder:
//   alan/          the installed bundle (bin/alanc, lib/, zig/, VERSION)
//   download.tmp   the archive while it downloads
//   alan.new       the bundle while it unpacks, renamed to alan at the end
//   alan.old       the previous bundle while it is replaced
// Nothing from the download runs during the install.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import * as yauzl from "yauzl";

export interface ReleaseSource {
  /** The GitHub API URL of the latest release, whose JSON has tag_name. */
  apiLatest: string;
  /** The URL of an asset of the release tagged tag. */
  download: (tag: string, asset: string) => string;
}

const REPO = "sleousis/alan-compiler";

export const GITHUB: ReleaseSource = {
  apiLatest: `https://api.github.com/repos/${REPO}/releases/latest`,
  download: (tag, asset) => `https://github.com/${REPO}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`,
};

/** The oldest compiler this extension works with. */
export const MIN_COMPILER = "v2.0.0";

/** The installer script that WSL mode runs inside WSL. */
export const INSTALL_SH_URL = `https://raw.githubusercontent.com/${REPO}/master/install/install.sh`;

const NO_RELEASE = "No Alan release for this platform.";
const OFFLINE = "Could not reach GitHub. Check your connection and try again.";
const MISMATCH = "The download did not match its checksum. Nothing was installed.";
const CANCELLED = "Installation cancelled. Nothing was installed.";
const IN_USE = "The installed Alan compiler is in use. Stop the programs that use it and try again.";

/** No data from the server for this long counts as offline. */
const IDLE_MS = 30_000;
/** Largest answer read into memory (the release JSON and SHA256SUMS). */
const TEXT_LIMIT = 4 * 1024 * 1024;
/** Zip entries unpacked at the same time. */
const ZIP_PARALLEL = 16;
/** Tar entries being written before reading the archive pauses. */
const TAR_PARALLEL = 64;

/** An error whose message a person can act on. */
class InstallError extends Error {}

/** The release platform for a Node platform and CPU: "win32","arm64" gives "windows-arm64". */
export function platformId(platform: NodeJS.Platform, arch: string): string {
  const os = ({ win32: "windows", linux: "linux", darwin: "macos" } as Partial<Record<NodeJS.Platform, string>>)[platform];
  if (!os || (arch !== "x64" && arch !== "arm64")) throw new Error(NO_RELEASE);
  return `${os}-${arch}`;
}

/** The bundle's file name, like alan-v2.0.0-windows-x64.zip or alan-v2.0.0-macos-arm64.tar.gz. */
export function assetName(tag: string, platform: NodeJS.Platform, arch: string): string {
  return `alan-${tag}-${platformId(platform, arch)}.${platform === "win32" ? "zip" : "tar.gz"}`;
}

function compilerName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "alanc.exe" : "alanc";
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

/** Path of the compiler installed into storageDir for platform, if there is one. */
export function installedCompilerPath(storageDir: string, platform: NodeJS.Platform): string | undefined {
  const exe = path.join(storageDir, "alan", "bin", compilerName(platform));
  return isFile(exe) ? exe : undefined;
}

/** The release tag of the installed bundle, from its VERSION file. */
export function installedTag(storageDir: string): string | undefined {
  try {
    const tag = fs.readFileSync(path.join(storageDir, "alan", "VERSION"), "utf8").split(/\r?\n/)[0].trim();
    return tag && tag.length <= 64 ? tag : undefined;
  } catch {
    return undefined;
  }
}

const VERSION_TAG = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** True when tag is an older version than other. A tag that is not a version counts as older. */
export function isOlderTag(tag: string, other: string): boolean {
  const a = VERSION_TAG.exec(tag);
  const b = VERSION_TAG.exec(other);
  if (!b) return false;
  if (!a) return true;
  for (let i = 1; i <= 3; i++) {
    const d = Number(a[i]) - Number(b[i]);
    if (d) return d < 0;
  }
  // A pre-release like v2.0.0-rc1 comes before v2.0.0.
  if (a[4] === undefined || b[4] === undefined) return a[4] !== undefined && b[4] === undefined;
  return a[4] < b[4];
}

function cancelled(signal?: AbortSignal): boolean {
  return signal?.aborted ?? false;
}

// ---- downloads ----

/** The answer to a GET of url with status 200, after redirects. 404 means there is no such release. */
function get(url: string, signal?: AbortSignal, redirects = 5): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const client = u.protocol === "https:" ? https : u.protocol === "http:" ? http : undefined;
    if (!client) return reject(new Error(`Unsupported download address ${url}`));
    const req = client.get(u, { headers: { "User-Agent": "alan-vscode", Accept: "*/*" }, signal, timeout: IDLE_MS }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, u);
        if (redirects === 0 || (u.protocol === "https:" && next.protocol !== "https:")) {
          return reject(new InstallError(`GitHub sent an unexpected redirect for ${u.pathname}. Try again later.`));
        }
        return resolve(get(next.href, signal, redirects - 1));
      }
      if (status === 200) return resolve(res);
      res.resume();
      if (status === 404) return reject(new InstallError(NO_RELEASE));
      reject(new InstallError(`GitHub answered with HTTP ${status}. Try again in a few minutes.`));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", () => reject(new InstallError(cancelled(signal) ? CANCELLED : OFFLINE)));
  });
}

/** The error to report when reading an answer failed. */
function readError(e: unknown, res: http.IncomingMessage, signal?: AbortSignal): unknown {
  if (cancelled(signal)) return new InstallError(CANCELLED);
  if (e instanceof InstallError) return e;
  return res.complete ? e : new InstallError(OFFLINE);
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const res = await get(url, signal);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of res as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > TEXT_LIMIT) throw new InstallError(`GitHub sent an unexpectedly large answer for ${url}. Try again later.`);
      chunks.push(chunk);
    }
  } catch (e) {
    throw readError(e, res, signal);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function latestTag(src: ReleaseSource, signal?: AbortSignal): Promise<string> {
  const text = await fetchText(src.apiLatest, signal);
  let tag: unknown;
  try {
    tag = (JSON.parse(text) as { tag_name?: unknown }).tag_name;
  } catch {
    // Reported below.
  }
  if (typeof tag !== "string" || !tag.startsWith("v") || !VERSION_TAG.test(tag)) {
    throw new InstallError("GitHub did not name a valid latest Alan release. Try again later.");
  }
  return tag;
}

/** The lowercase SHA-256 that sums, in sha256sum format, lists for name. */
function checksumFor(sums: string, name: string): string | undefined {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trimEnd());
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  return undefined;
}

/** Downloads url into file and returns its SHA-256. */
async function download(
  url: string, file: string, signal: AbortSignal | undefined, onBytes: (got: number, total: number) => void,
): Promise<string> {
  const res = await get(url, signal);
  const total = Number(res.headers["content-length"]) || 0;
  const hash = createHash("sha256");
  let got = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      got += chunk.length;
      onBytes(got, total);
      done(null, chunk);
    },
  });
  try {
    await pipeline(res, meter, fs.createWriteStream(file), { signal });
  } catch (e) {
    throw readError(e, res, signal);
  }
  if (!res.complete || (total && got !== total)) throw new InstallError(OFFLINE);
  return hash.digest("hex");
}

// ---- unpacking ----

function unsafePath(name: string): InstallError {
  return new InstallError(`The download holds an unsafe path (${name}). Nothing was installed.`);
}

function badLink(name: string): InstallError {
  return new InstallError(`The download holds a link that is not allowed (${name}). Nothing was installed.`);
}

function inside(dest: string, target: string): boolean {
  return target.startsWith(dest + path.sep);
}

/**
 * Where an archive entry goes: its path without the top alan/ folder,
 * inside dest. undefined for alan/ itself. Throws for an absolute path, a
 * .. part, a backslash, or an entry outside alan/.
 */
function entryTarget(dest: string, name: string): string | undefined {
  if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw unsafePath(name);
  }
  const parts = name.split("/").filter((p) => p !== "" && p !== ".");
  // A colon on Windows would name an alternate data stream.
  if (parts[0] !== "alan" || parts.some((p) => p === ".." || (process.platform === "win32" && p.includes(":")))) {
    throw unsafePath(name);
  }
  if (parts.length === 1) return undefined;
  const target = path.resolve(dest, ...parts.slice(1));
  if (!inside(dest, target)) throw unsafePath(name);
  return target;
}

/** mkdir -p that makes each folder once. */
function folderMaker(): (dir: string) => Promise<unknown> {
  const made = new Map<string, Promise<unknown>>();
  return (dir) => {
    let p = made.get(dir);
    if (!p) made.set(dir, (p = fsp.mkdir(dir, { recursive: true })));
    return p;
  };
}

function badArchive(e: unknown): InstallError {
  if (e instanceof InstallError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  // yauzl's own name checks.
  const m = /^(?:absolute path|invalid relative path|invalid characters in fileName): (.*)$/.exec(msg);
  if (m) return unsafePath(m[1]);
  return new InstallError(`The download could not be unpacked (${msg}). Nothing was installed.`);
}

/**
 * Unpacks a zip, several entries at a time. On an error it stops reading
 * and settles once the entries being written are done, so nothing writes
 * into dest after the caller removes it.
 */
function unzip(
  file: string, dest: string, onProgress?: (done: number, total: number) => void, signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) return reject(badArchive(err));
      const total = zip.entryCount;
      const folder = folderMaker();
      let done = 0;
      let running = 0;
      let reading = false;
      let ended = false;
      let settled = false;
      let error: unknown;
      const settle = () => {
        if (settled || running > 0) return;
        settled = true;
        zip.close();
        if (error !== undefined) reject(error);
        else resolve();
      };
      const fail = (e: unknown) => {
        error ??= badArchive(e);
        settle();
      };
      const pump = () => {
        if (error === undefined && cancelled(signal)) error = new InstallError(CANCELLED);
        if (error !== undefined || ended) return settle();
        if (reading || running >= ZIP_PARALLEL) return;
        reading = true;
        zip.readEntry();
      };
      const unpack = async (entry: yauzl.Entry) => {
        const target = entryTarget(dest, entry.fileName);
        const type = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (type === 0o120000) throw badLink(entry.fileName);
        if (type !== 0 && type !== 0o100000 && type !== 0o040000) throw unsafePath(entry.fileName);
        if (!target) return;
        if (entry.fileName.endsWith("/") || type === 0o040000) {
          await folder(target);
          return;
        }
        await folder(path.dirname(target));
        const input = await zip.openReadStreamPromise(entry);
        // wx: an entry never replaces a file that is already there.
        await pipeline(input, fs.createWriteStream(target, { flags: "wx" }));
      };
      zip.on("entry", (entry: yauzl.Entry) => {
        reading = false;
        if (error !== undefined) return settle();
        running++;
        unpack(entry).then(() => {
          running--;
          onProgress?.(++done, total);
          pump();
        }, (e: unknown) => {
          running--;
          fail(e);
        });
        pump();
      });
      zip.on("end", () => {
        reading = false;
        ended = true;
        pump();
      });
      zip.on("error", (e: unknown) => {
        reading = false;
        fail(e);
      });
      pump();
    });
  });
}

/** A path as the file system compares it: macOS and Windows ignore case. */
function pathKey(p: string): string {
  return process.platform === "linux" ? p : p.normalize("NFC").toLowerCase();
}

/** True when a folder above p inside dest is one of the symbolic links unpacked so far. */
function throughLink(dest: string, p: string, links: Set<string>): boolean {
  for (let dir = path.dirname(p); inside(dest, dir); dir = path.dirname(dir)) {
    if (links.has(pathKey(dir))) return true;
  }
  return false;
}

/**
 * Where a tar entry goes, and for a hard link the file it links to. Throws
 * when the entry may not be unpacked into dest. links holds the symbolic
 * links unpacked so far: nothing is unpacked through one, since a link that
 * points to a shallower folder would let a later link climb out of dest.
 */
function tarTarget(dest: string, entry: tar.ReadEntry, links: Set<string>): { target?: string; linked?: string } {
  const target = entryTarget(dest, entry.path);
  if (target && throughLink(dest, target, links)) throw badLink(entry.path);
  switch (entry.type) {
    case "File":
    case "OldFile":
    case "ContiguousFile":
    case "Directory":
      return { target };
    case "SymbolicLink": {
      const link = entry.linkpath ?? "";
      if (!target || !link || link.includes("\\") || path.isAbsolute(link) || /^[A-Za-z]:/.test(link)
        || !inside(dest, path.resolve(path.dirname(target), link))) {
        throw badLink(entry.path);
      }
      return { target };
    }
    case "Link": {
      let linked: string | undefined;
      try {
        linked = entryTarget(dest, entry.linkpath ?? "");
      } catch {
        // Reported below.
      }
      if (!target || !linked || throughLink(dest, linked, links) || links.has(pathKey(linked))) throw badLink(entry.path);
      return { target, linked };
    }
    default:
      throw unsafePath(entry.path);
  }
}

/**
 * Unpacks a tar.gz. node-tar only parses it: the files are written here,
 * many at a time, which is much faster than its own one-by-one unpacking.
 * After a refused entry or a cancel the rest of the archive is skipped, and
 * it settles once the writes already started are done.
 */
async function untar(
  file: string, dest: string, onProgress?: (done: number, total: number) => void, signal?: AbortSignal,
): Promise<void> {
  const total = (await fsp.stat(file)).size;
  const folder = folderMaker();
  const written = new Map<string, Promise<unknown>>();
  const links = new Set<string>();
  await new Promise<void>((resolve, reject) => {
    const input = fs.createReadStream(file);
    let error: unknown;
    let pending = 0;
    let ended = false;
    let settled = false;
    const settle = () => {
      if (settled || !ended || pending > 0) return;
      settled = true;
      if (error !== undefined) reject(error);
      else resolve();
    };
    // Reading pauses while the parser holds data nobody reads yet, or while
    // TAR_PARALLEL entries are being written, so memory stays small. Only the
    // entry being parsed can wait for more data, so the writes always finish.
    let parserFull = false;
    const flow = () => {
      if (parserFull || pending >= TAR_PARALLEL) input.pause();
      else input.resume();
    };
    const track = (work: Promise<unknown>) => {
      pending++;
      work.catch((e: unknown) => {
        error ??= badArchive(e);
      }).finally(() => {
        pending--;
        flow();
        settle();
      });
      return work;
    };
    const unpack = (entry: tar.ReadEntry) => {
      if (error === undefined && cancelled(signal)) error = new InstallError(CANCELLED);
      if (error !== undefined) return entry.resume();
      let where: { target?: string; linked?: string };
      try {
        where = tarTarget(dest, entry, links);
      } catch (e) {
        error = e;
        return entry.resume();
      }
      const { target, linked } = where;
      if (!target) return entry.resume();
      if (entry.type === "Directory") {
        entry.resume();
        return void track(folder(target));
      }
      if (entry.type === "SymbolicLink" || entry.type === "Link") {
        entry.resume();
        if (!linked) links.add(pathKey(target));
        return void track((async () => {
          await folder(path.dirname(target));
          if (linked) {
            await written.get(linked);
            await fsp.link(linked, target);
          } else {
            await fsp.symlink(entry.linkpath ?? "", target);
          }
        })());
      }
      // Minipass keeps the entry's data until the pipe below reads it.
      written.set(target, track((async () => {
        await folder(path.dirname(target));
        // wx: an entry never replaces a file that is already there.
        await pipeline(entry, fs.createWriteStream(target, { flags: "wx", mode: ((entry.mode ?? 0o644) & 0o777) | 0o600 }));
      })()));
    };
    const parser = new tar.Parser({ strict: true, onReadEntry: unpack });
    parser.on("error", (e: unknown) => {
      error ??= badArchive(e);
    });
    parser.on("end", () => {
      ended = true;
      settle();
    });
    parser.on("drain", () => {
      parserFull = false;
      flow();
    });
    let read = 0;
    input.on("data", (chunk) => {
      read += chunk.length;
      onProgress?.(read, total);
      parserFull = !parser.write(chunk as Buffer);
      flow();
    });
    input.on("end", () => parser.end());
    input.on("error", (e) => {
      error ??= badArchive(e);
      parser.end();
    });
  });
}

/**
 * Unpacks a release bundle into dest, an empty folder, without its top
 * alan/ folder. Entries outside alan/, absolute paths, .. parts, device
 * files and links that lead out of dest fail the whole archive, and zip
 * archives may hold no links at all. onProgress hears entries done (zip) or
 * bytes read (tar.gz).
 */
export async function extractArchive(
  file: string, dest: string, kind: "zip" | "tar.gz",
  onProgress?: (done: number, total: number) => void, signal?: AbortSignal,
): Promise<void> {
  const root = path.resolve(dest);
  if (kind === "zip") await unzip(file, root, onProgress, signal);
  else await untar(file, root, onProgress, signal);
}

// ---- install and removal ----

function isBusy(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "ENOTEMPTY";
}

/** Renames, trying again for a moment while a virus scanner holds new files open. */
async function rename(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fsp.rename(from, to);
    } catch (e) {
      if (!isBusy(e)) throw e;
      if (attempt === 8) throw new InstallError(IN_USE);
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    }
  }
}

function remove(p: string): Promise<void> {
  return fsp.rm(p, { recursive: true, force: true, maxRetries: 5 });
}

/** Moves fresh to dest. An old dest comes back if that fails, and goes otherwise. */
async function replaceFolder(fresh: string, dest: string): Promise<void> {
  const old = `${dest}.old`;
  await remove(old);
  const hadOld = fs.existsSync(dest);
  if (hadOld) await rename(dest, old);
  try {
    await rename(fresh, dest);
  } catch (e) {
    if (hadOld) await fsp.rename(old, dest).catch(() => {});
    throw e;
  }
  // A copy that cannot go yet goes with the next install or removal.
  if (hadOld) await remove(old).catch(() => {});
}

function clearQuarantine(dir: string): Promise<void> {
  // xattr fails for files without the attribute. That is fine.
  return new Promise((resolve) => execFile("xattr", ["-dr", "com.apple.quarantine", dir], { timeout: 60_000 }, () => resolve()));
}

function friendly(e: unknown, signal?: AbortSignal): Error {
  if (cancelled(signal)) return new Error(CANCELLED);
  if (e instanceof InstallError) return new Error(e.message);
  if ((e as NodeJS.ErrnoException | undefined)?.code === "ENOSPC") {
    return new Error("There is not enough disk space for the Alan compiler. Nothing was installed.");
  }
  return new Error(`Could not install the Alan compiler: ${e instanceof Error ? e.message : String(e)}`);
}

/**
 * Installs the latest release into storageDir/alan, replacing an old copy
 * only once the new one is complete. progress hears a message and a
 * percentage from 0 to 100. On an error nothing new stays behind and an old
 * copy still works.
 */
export async function install(
  storageDir: string, src: ReleaseSource, platform: NodeJS.Platform, arch: string,
  progress?: (msg: string, pct: number) => void, signal?: AbortSignal,
): Promise<{ tag: string; alanc: string }> {
  platformId(platform, arch);
  if (cancelled(signal)) throw new Error(CANCELLED);
  // Reports each whole percent once, and each new step (the message's first word).
  let last = -1;
  let step = "";
  const report = (msg: string, pct: number) => {
    const p = Math.floor(Math.min(100, Math.max(last, pct)));
    const s = msg.split(" ")[0];
    if (p === last && s === step) return;
    last = p;
    step = s;
    progress?.(msg, p);
  };
  const tmp = path.join(storageDir, "download.tmp");
  const fresh = path.join(storageDir, "alan.new");
  const dest = path.join(storageDir, "alan");
  await fsp.mkdir(storageDir, { recursive: true });
  try {
    report("Looking for the latest release", 0);
    const tag = await latestTag(src, signal);
    if (isOlderTag(tag, MIN_COMPILER)) throw new InstallError(NO_RELEASE);
    const asset = assetName(tag, platform, arch);
    const want = checksumFor(await fetchText(src.download(tag, "SHA256SUMS"), signal), asset);
    if (!want) throw new InstallError(NO_RELEASE);

    const mb = (n: number) => (n / 1048576).toFixed(1);
    const got = await download(src.download(tag, asset), tmp, signal, (n, size) => {
      report(size ? `Downloading ${mb(n)} of ${mb(size)} MB` : `Downloading ${mb(n)} MB`, size ? 2 + (68 * n) / size : 2);
    });
    if (got !== want) throw new InstallError(MISMATCH);

    await remove(fresh);
    await fsp.mkdir(fresh);
    report("Unpacking", 70);
    await extractArchive(tmp, fresh, platform === "win32" ? "zip" : "tar.gz",
      (n, size) => report("Unpacking", 70 + (27 * n) / Math.max(size, 1)), signal);
    const exe = compilerName(platform);
    if (!isFile(path.join(fresh, "bin", exe))) {
      throw new InstallError(`The download has no alan/bin/${exe}. Nothing was installed.`);
    }
    if (platform !== "win32") {
      for (const rel of ["bin/alanc", "zig/zig"]) {
        await fsp.chmod(path.join(fresh, rel), 0o755).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== "ENOENT") throw e;
        });
      }
    }
    if (platform === "darwin") await clearQuarantine(fresh);
    if (cancelled(signal)) throw new InstallError(CANCELLED);

    report("Finishing", 98);
    await remove(tmp);
    await replaceFolder(fresh, dest);
    report(`Installed Alan ${tag}`, 100);
    return { tag, alanc: path.join(dest, "bin", exe) };
  } catch (e) {
    await remove(tmp).catch(() => {});
    await remove(fresh).catch(() => {});
    throw friendly(e, signal);
  }
}

/** Removes the installed compiler and anything an interrupted install left in storageDir. */
export async function uninstall(storageDir: string): Promise<void> {
  const dest = path.join(storageDir, "alan");
  const old = `${dest}.old`;
  try {
    await remove(old);
    // A rename first, so a compiler in use keeps all its files instead of half of them.
    if (fs.existsSync(dest)) await rename(dest, old);
    await remove(old);
    await remove(path.join(storageDir, "alan.new"));
    await remove(path.join(storageDir, "download.tmp"));
  } catch (e) {
    if (e instanceof InstallError) throw new Error(e.message);
    throw new Error(`Could not remove the Alan compiler: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---- WSL mode ----

/**
 * Downloads install.sh into a temporary file and runs it, so a failed
 * download fails the command instead of running part of a script. The URL
 * reaches the script as $0, never as part of its text.
 */
const WSL_INSTALL = 't=$(mktemp) || exit 1; curl -fsSL "$0" -o "$t" && sh "$t"; r=$?; rm -f "$t"; exit $r';

/** Removes what install.sh installed. ~/.local/bin/alanc goes only if it is the link install.sh made. */
const WSL_UNINSTALL = 'rm -rf "$HOME/.local/share/alan" "$HOME/.local/share/alan.new" && '
  + 'if [ -L "$HOME/.local/bin/alanc" ]; then rm -f "$HOME/.local/bin/alanc"; fi';

/** The command that installs the compiler inside WSL with install/install.sh. */
export function wslInstallCommand(): { cmd: string; args: string[] } {
  return { cmd: "wsl.exe", args: ["-e", "sh", "-c", WSL_INSTALL, INSTALL_SH_URL] };
}

/** The command that removes the compiler install.sh put inside WSL. */
export function wslUninstallCommand(): { cmd: string; args: string[] } {
  return { cmd: "wsl.exe", args: ["-e", "sh", "-c", WSL_UNINSTALL] };
}
