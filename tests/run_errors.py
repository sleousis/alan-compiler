#!/usr/bin/env python3
"""Runs `alanc check` on programs with errors and checks the error line."""
import argparse, json, pathlib, re, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

def check(alanc: str, file: str):
    r = subprocess.run([alanc, "check", str(ROOT / file)],
                       stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
    return r.returncode, r.stderr.decode("latin-1")

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--alanc", required=True)
    a = ap.parse_args()
    cases = json.loads((ROOT / "tests/errors/expected.json").read_text())
    failed = 0
    for c in cases:
        code, err = check(a.alanc, c["file"])
        name = pathlib.PurePath(c["file"]).name
        pattern = re.compile(r"^" + re.escape(name) + r":(\d+): error: ")
        lines = [int(m.group(1)) for m in map(pattern.match, err.splitlines()) if m]
        ok = (code == 1 and c["contains"] in err and lines
              and (c["line"] is None or c["line"] in lines))
        if ok:
            print("PASS", c["file"])
        else:
            failed += 1
            print("FAIL", c["file"], "exit", code, "want line", c["line"])
            sys.stdout.write(err)
    code, err = check(a.alanc, "Examples/HelloWorld.alan")
    if code == 0 and err == "":
        print("PASS Examples/HelloWorld.alan (no errors)")
    else:
        failed += 1
        print("FAIL Examples/HelloWorld.alan exit", code)
        sys.stdout.write(err)
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(main())
