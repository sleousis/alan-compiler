#!/usr/bin/env python3
"""Builds runtime/test/rt_test.c with the runtime and compares its output."""
import argparse, os, pathlib, platform, subprocess, sys, tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
RT = ROOT / "runtime"


def host_target() -> str:
    """The target that alanc builds programs for on this host."""
    arch = "aarch64" if platform.machine().lower() in ("arm64", "aarch64") else "x86_64"
    if sys.platform == "win32":
        return arch + "-windows-gnu"
    if sys.platform == "darwin":
        return arch + "-macos"
    return arch + "-linux-musl"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--zig", default=os.environ.get("ALAN_ZIG") or "zig")
    ap.add_argument("--target", default=host_target())
    a = ap.parse_args()
    with tempfile.TemporaryDirectory() as d:
        exe = pathlib.Path(d) / ("rt_test.exe" if sys.platform == "win32" else "rt_test")
        sources = [str(RT / "test/rt_test.c")] + [str(RT / f) for f in ("io.c", "str.c", "conv.c")]
        subprocess.run([a.zig, "cc", "-target", a.target, "-O2", "-std=c17", "-o", str(exe)]
                       + sources, check=True, timeout=600)
        stdin = (RT / "test/rt_test_input.txt").read_bytes()
        r = subprocess.run([str(exe)], input=stdin, capture_output=True, timeout=60)
    want = (RT / "test/rt_test_expected.txt").read_bytes()
    got = r.stdout.replace(b"\r\n", b"\n")
    if r.returncode == 0 and got == want:
        print("PASS rt_test", a.target)
        return 0
    print("FAIL rt_test", a.target, "exit", r.returncode)
    print("expected:", want)
    print("got:     ", got)
    return 1


if __name__ == "__main__":
    sys.exit(main())
