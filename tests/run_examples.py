#!/usr/bin/env python3
"""Runs every case through `alanc run` and compares with tests/expected."""
import argparse, difflib, json, os, pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
# ALAN_EXAMPLES_DIR runs the cases of Examples/ from another folder, such as formatted copies.
EXAMPLES = pathlib.Path(os.environ.get("ALAN_EXAMPLES_DIR") or ROOT / "Examples")

def source(file: str) -> pathlib.Path:
    if file.startswith("Examples/"):
        return EXAMPLES / file[len("Examples/"):]
    return ROOT / file

def normalize(b: bytes) -> str:
    return b.replace(b"\r\n", b"\n").decode("latin-1")

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--alanc", required=True)
    ap.add_argument("--only")
    a = ap.parse_args()
    cases = json.loads((ROOT / "tests/cases.json").read_text())
    failed = 0
    for c in cases:
        if a.only and c["name"] != a.only:
            continue
        cmd = [a.alanc, "run", str(source(c["file"]))] + (["-O"] if c["opt"] else [])
        stdin = (ROOT / "tests" / c["input"]).read_bytes() if c["input"] else b""
        r = subprocess.run(cmd, input=stdin, capture_output=True, timeout=120)
        expected = c.get("expected") or "expected/" + c["name"] + ".txt"
        want = normalize((ROOT / "tests" / expected).read_bytes())
        got = normalize(r.stdout)
        label = c["name"] + (" -O" if c["opt"] else "")
        if r.returncode == 0 and got == want:
            print("PASS", label)
        else:
            failed += 1
            print("FAIL", label, "exit", r.returncode)
            sys.stdout.write(r.stderr.decode("latin-1"))
            sys.stdout.writelines(difflib.unified_diff(
                want.splitlines(True), got.splitlines(True), "expected", "got"))
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(main())
