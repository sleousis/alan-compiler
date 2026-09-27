// Translates Windows paths into the paths WSL sees, so a compiler inside
// WSL can open files that VS Code on Windows has open.

/**
 * C:\a b\x.alan becomes /mnt/c/a b/x.alan, and a file inside WSL
 * (\\wsl$\Ubuntu\home\x.alan or \\wsl.localhost\Ubuntu\home\x.alan) becomes
 * /home/x.alan. A path that is already a Linux path stays as it is. Throws
 * for a network share or a relative path, which WSL cannot open.
 */
export function toWslPath(winPath: string): string {
  if (winPath.startsWith("/") && !winPath.startsWith("//")) return winPath;
  let p = winPath.replace(/\\/g, "/");
  if (p.startsWith("//?/")) p = p.slice(4);

  const drive = /^([A-Za-z]):(\/.*)?$/.exec(p);
  if (drive) return `/mnt/${drive[1].toLowerCase()}${drive[2] ?? ""}`;

  // //wsl$/<distro>/<path> or //wsl.localhost/<distro>/<path>
  const inWsl = /^\/\/(?:wsl\$|wsl\.localhost)\/[^/]+(\/.*)?$/i.exec(p);
  if (inWsl) return inWsl[1] ?? "/";

  throw new Error(`WSL cannot open ${winPath}. Save the file on a local drive or inside WSL.`);
}
