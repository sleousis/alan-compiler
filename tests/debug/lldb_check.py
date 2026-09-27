#!/usr/bin/env python3
"""Builds tests/debug/dbg.alan with `alanc build -g` and checks that LLDB
stops on a source line, shows the parameters and names the frame."""
import argparse, pathlib, subprocess, sys, tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
SOURCE = ROOT / "tests/debug/dbg.alan"
WANT = ["dbg.alan:5", "(int) a = 40", "(int) b = 2", "`add"]

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--alanc", required=True)
    ap.add_argument("--lldb", default="lldb")
    a = ap.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        exe = pathlib.Path(tmp) / ("dbg.exe" if sys.platform == "win32" else "dbg")
        r = subprocess.run([a.alanc, "build", "-g", str(SOURCE), "-o", str(exe)],
                           stdin=subprocess.DEVNULL, capture_output=True, timeout=300)
        if r.returncode != 0:
            print("FAIL alanc build -g exit", r.returncode)
            sys.stdout.write(r.stderr.decode("latin-1"))
            return 1
        r = subprocess.run([a.lldb, "--batch",
                            "-o", "breakpoint set --file dbg.alan --line 5",
                            "-o", "run", "-o", "frame variable a b", "-o", "bt",
                            "-o", "continue", str(exe)],
                           stdin=subprocess.DEVNULL, capture_output=True, timeout=300)
        out = r.stdout.decode("latin-1") + r.stderr.decode("latin-1")
        sys.stdout.write(out)
        missing = [w for w in WANT if w not in out]
        if missing:
            print("FAIL lldb output lacks", ", ".join(repr(w) for w in missing))
            return 1
        print("PASS lldb stops in add at dbg.alan:5 with a = 40 and b = 2")
        return 0

if __name__ == "__main__":
    sys.exit(main())
