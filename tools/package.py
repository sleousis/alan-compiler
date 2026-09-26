#!/usr/bin/env python3
import argparse, pathlib, shutil, tarfile, zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--platform", required=True, choices=[
        "windows-x64", "windows-arm64", "linux-x64", "linux-arm64", "macos-x64", "macos-arm64"])
    ap.add_argument("--version", required=True)
    ap.add_argument("--zig", required=True, help="extracted Zig distribution folder")
    a = ap.parse_args()
    stage = ROOT / "out" / "stage" / "alan"
    shutil.rmtree(stage.parent, ignore_errors=True)
    shutil.copytree(ROOT / "dist" / a.platform, stage)
    shutil.copytree(a.zig, stage / "zig")
    shutil.copy(ROOT / "bundle-README.txt", stage / "README.txt")
    # bytes, so the line ends in LF on Windows too (Python 3.8 has no newline= here)
    (stage / "VERSION").write_bytes((a.version + "\n").encode())
    name = f"alan-{a.version}-{a.platform}"
    out = ROOT / "out"
    if a.platform.startswith("windows-"):
        with zipfile.ZipFile(out / f"{name}.zip", "w", zipfile.ZIP_DEFLATED) as z:
            for p in stage.rglob("*"):
                z.write(p, p.relative_to(stage.parent))
    else:
        with tarfile.open(out / f"{name}.tar.gz", "w:gz") as t:
            t.add(stage, arcname="alan")
    print(out / name)

if __name__ == "__main__":
    main()
