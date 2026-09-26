#!/bin/bash
# Records tests/expected/*.txt with the verified legacy pipeline.
# Runs in WSL: ./alan (alanc, llc, clang) with LLVM 23 and the assembly runtime.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH=/usr/lib/llvm-23/bin:$PATH
make -s
python3 - <<'EOF'
import json, os, pathlib, shutil, subprocess, tempfile, time

root = pathlib.Path.cwd()
cases = json.load(open("tests/cases.json"))
# ./alan needs a FILE ending in .alan and writes FILE's base name as a
# folder in the current directory. Run it in a scratch folder that links
# to the compiler and runtime, so it never touches the checkout.
work = pathlib.Path(tempfile.mkdtemp(prefix="alan_record_"))
for name in ("alan", "alanc", "alan_lib_v2"):
    os.symlink(root / name, work / name)
try:
    for c in cases:
        src = work / (c["name"] + ".alan")
        shutil.copyfile(root / c["file"], src)
        args = ["./alan"] + (["-O"] if c["opt"] else []) + [src.name]
        subprocess.run(args, cwd=work, check=True, stdout=subprocess.DEVNULL)
        exe = work / c["name"] / c["name"]
        data = (root / "tests" / c["input"]).read_bytes() if c["input"] else b""
        # Feed input one line at a time: the legacy runtime reads raw
        # syscalls and would swallow several lines in one read().
        p = subprocess.Popen([str(exe)], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        for line in data.splitlines(keepends=True):
            time.sleep(0.2)
            p.stdin.write(line)
            p.stdin.flush()
        out, _ = p.communicate()
        if p.returncode != 0:
            raise SystemExit(f"{c['name']} exited with {p.returncode}, nothing recorded")
        (root / "tests/expected" / (c["name"] + ".txt")).write_bytes(out)
        print("recorded", c["name"], len(out), "exit", p.returncode)
finally:
    shutil.rmtree(work)
EOF
