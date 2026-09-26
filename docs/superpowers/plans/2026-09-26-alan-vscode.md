# Alan Editor Support and Cross-Platform Toolchain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a self-contained Alan toolchain for Windows, Linux and macOS on x64 and ARM64, one-line installers, and a VS Code extension with highlighting, live diagnostics, completion, hover, formatting, rename, one-click run and a debugger.

**Architecture:** `alanc` keeps its parser, checker and LLVM code generation. It gains `check`, `build` and `run` commands, writes object files itself, and links them with a new C runtime through a bundled Zig toolchain. The VS Code extension has its own TypeScript lexer and parser for live feedback, and calls `alanc` for type errors and running.

**Tech Stack:** C++17, flex 2.6.4, bison 3.8.2, LLVM 23.1.2 (static), C17 runtime, Zig (pinned, used as `zig cc`), CMake 3.28 or newer, Python 3.14 (test harness), TypeScript 5, Node 22 LTS or newer, `vscode-languageserver`, `vscode-languageclient`, esbuild, mocha, `@vscode/test-electron`, `@vscode/vsce`, `ovsx`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-26-alan-vscode-design.md`

## Global Constraints

- Platforms: native Windows, Linux and macOS, each on x64 and ARM64. Platform ids: `windows-x64`, `windows-arm64`, `linux-x64`, `linux-arm64`, `macos-x64`, `macos-arm64`. WSL on Windows is an optional mode (`alan.useWsl`, default false).
- LLVM sources per platform: official LLVM 23.1.2 packages (`clang+llvm-23.1.2-x86_64-pc-windows-msvc`, `clang+llvm-23.1.2-aarch64-pc-windows-msvc`, `LLVM-23.1.2-Linux-X64`, `LLVM-23.1.2-Linux-ARM64`, `LLVM-23.1.2-macOS-ARM64`), and Homebrew `llvm` 23 for `macos-x64`.
- Zig version: 0.16.0.
- CI runners: `windows-latest`, `windows-11-arm`, `ubuntu-latest` (container `ubuntu:20.04`), `ubuntu-24.04-arm` (container `arm64v8/ubuntu:20.04`), `macos-latest`, and the Intel macOS runner label available at the time (check GitHub's runner list, for example `macos-15-intel`).
- Debugger: `alanc build -g` / `alanc run -g` emit DWARF with optimisation off. The extension depends on `vadimcn.vscode-lldb`.
- One C runtime for both platforms. `alan_lib_v2/` stays in the repo unchanged and is no longer built by the new pipeline.
- `alanc file.alan [-O]` keeps writing LLVM IR to standard output exactly as today. The `alan` and `do.sh` scripts keep working.
- New commands: `alanc check file.alan`, `alanc build file.alan [-o name] [-O]`, `alanc run file.alan [-O]`.
- Runtime symbols are prefixed `alan_`. Alan source names do not change.
- Error format: `file:line: error: message`. ANSI colours only when standard error is a terminal.
- Link targets: `x86_64-windows-gnu`, `aarch64-windows-gnu`, `x86_64-linux-musl`, `aarch64-linux-musl` (static), `x86_64-macos`, `aarch64-macos`.
- Linux `alanc` is built in `ubuntu:20.04` (glibc 2.31 floor). LLVM is linked statically on every platform.
- Bundle names: `alan-<version>-<platform>.zip` for Windows, `alan-<version>-<platform>.tar.gz` for Linux and macOS, plus `SHA256SUMS`.
- Compiler tags `v*`, next release `v2.0.0`. Extension tags `vscode-v*`, first release `vscode-v1.0.0`.
- Install locations: extension global storage, `%LOCALAPPDATA%\alan` (install.ps1), `~/.local/share/alan` with a link in `~/.local/bin` (install.sh).
- Compiler lookup order: `alan.compilerPath`, the extension's installed copy, `alanc` on PATH.
- Extension settings: `alan.compilerPath` (string, default ""), `alan.optimize` (bool, default true), `alan.useWsl` (bool, default false), `alan.checkOnSave` (bool, default true).
- Marketplace publisher `sleousis`. Secrets `VSCE_PAT`, `OVSX_PAT`. Publishing steps skip with a warning when a secret is missing.
- Commit messages: terse imperative, no AI attribution lines of any kind. Docs style: plain short sentences, no em dashes, no semicolons, never "wire", "wiring" or "dispatch".
- Nothing is installed on the developer's C: drive. Tools go under `D:\tools`. Linux work happens in WSL Ubuntu-20.04 with LLVM 23 from apt.llvm.org (already installed).

## Review Focus

- Paths with spaces or non-ASCII characters (for example `C:\Users\Σάββας\My Alan\hello.alan`) must build, run, check and install correctly. Owned by Task 4 and Task 13.
- Interactive programs must show prompts before waiting for input, so the runtime flushes standard output before every read. Owned by Task 2.
- Sources and input with CRLF line endings must lex, parse, compile and read exactly like LF. Owned by Task 2 and Task 9.
- Run, Build and Show IR on an unsaved or untitled document must ask to save first and never call the compiler on a missing file. Owned by Task 13.
- Install with no network, a GitHub API error or a checksum mismatch must fail with a clear message and leave no partial install behind. Owned by Task 14.

---

## File Structure

```
alan-compiler/
  CMakeLists.txt                 new: cross-platform build of alanc (Makefile stays)
  cli.cpp / cli.hpp              new: command parsing, tool lookup, build/run/check
  emit.cpp / emit.hpp            new: object file emission with TargetMachine
  debuginfo.cpp / debuginfo.hpp  new: DWARF generation with DIBuilder (-g)
  tests/debug/lldb_check.py      new: LLDB batch test of a debug build
  parser.y                       modify: main() delegates to cli, yyerror format
  error.cpp                      modify: colour only on a terminal, "error:" format
  ast.cpp                        modify: alan_ runtime symbol names, expose codegen entry
  runtime/                       new: C runtime
    alanrt.h, io.c, str.c, conv.c, build.sh, build.ps1
    test/rt_test.c, test/rt_test_input.txt, test/rt_test_expected.txt
  tests/                         new: example harness
    run_examples.py, cases.json, inputs/*.txt, expected/*.txt, errors/*.alan
  tools/versions.env             new: pinned tool versions
  tools/package.py               new: builds a bundle folder and archive
  install/install.sh, install/install.ps1   new
  .github/workflows/ci.yml, release.yml (replace), vscode-release.yml
  vscode/                        new: extension
    package.json, tsconfig.json, esbuild.mjs, .vscodeignore, README.md, CHANGELOG.md, icon.png
    language-configuration.json, syntaxes/alan.tmLanguage.json, snippets/alan.json
    src/client/extension.ts, compiler.ts, installer.ts, commands.ts, wsl.ts, debug.ts, platform.ts
    src/server/server.ts, lexer.ts, ast.ts, parser.ts, scopes.ts, library.ts,
               diagnostics.ts, completion.ts, hover.ts, symbols.ts, compilerCheck.ts,
               format.ts, rename.ts
    test/unit/*.test.ts, test/grammar/*.alan, test/e2e/*.test.ts, test/fixtures/*
```

---

### Task 1: Record expected outputs and the example harness

**Files:**
- Create: `tests/cases.json`, `tests/inputs/*.txt`, `tests/expected/*.txt`, `tests/run_examples.py`, `tests/record_legacy.sh`, `tools/versions.env`

**Interfaces:**
- Produces: `python tests/run_examples.py --alanc <path-to-alanc> [--only NAME]`. Exit 0 when every case matches, 1 otherwise. Prints `PASS name` or `FAIL name` plus a unified diff. Later tasks call it unchanged.
- `tests/cases.json` format: `[{"name": "BubbleSort", "file": "Examples/BubbleSort.alan", "input": "inputs/BubbleSort.txt" | null, "opt": true}]`.

- [ ] **Step 1: Pin tool versions**

Create `tools/versions.env`:

```
LLVM_VERSION=23.1.2
BISON_VERSION=3.8.2
FLEX_VERSION=2.6.4
ZIG_VERSION=0.16.0
```

Download that Zig for Windows to `D:\tools\zig-<ver>` and for Linux inside WSL to `~/tools/zig-<ver>`.

- [ ] **Step 2: Write the cases file**

One entry per example that ran in the earlier verification: every `Examples/*.alan` except `papariatest` without `-O` and except `prog11` (see below), plus `Examples/test` (file without extension). Use `"opt": true` for all cases (papariatest only compiles with `-O`). Inputs, one value per line, taken from the earlier verification run:

| Example | Input file content |
| --- | --- |
| HanoiTowers | `4` |
| prog19 | the input that printed `2 10` |
| prog20 | the input that printed `5` |
| any other example that calls readInteger/readString/readChar | a small valid value per read, one per line |

Find which examples read input with `grep -lE 'read(Integer|Byte|Char|String)' Examples/*.alan`. For each, read the source and write an input that exercises it. Leave `prog11` out of the cases because it answered "no" to every magic square tried and its expected behaviour is unknown. Mention it in `tests/README.md` as untested.

- [ ] **Step 3: Record expected output from the current pipeline**

Create `tests/record_legacy.sh` (runs in WSL, uses today's `./alan` script, LLVM 23, assembly runtime):

```bash
#!/bin/bash
# Records tests/expected/*.txt with the verified legacy pipeline.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH=/usr/lib/llvm-23/bin:$PATH
make -s
python3 - <<'EOF'
import json, subprocess, pathlib
cases = json.load(open("tests/cases.json"))
for c in cases:
    exe = f"/tmp/alan_case_{c['name']}"
    args = ["./alan", "-O", "-o", exe, c["file"]]
    subprocess.run(args, check=True)
    data = pathlib.Path("tests", c["input"]).read_bytes() if c["input"] else b""
    # Feed input one line at a time: the legacy runtime reads raw syscalls.
    p = subprocess.Popen([exe], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    for line in data.splitlines(keepends=True):
        p.stdin.write(line); p.stdin.flush()
        import time; time.sleep(0.05)
    out, _ = p.communicate()
    pathlib.Path("tests/expected", c["name"] + ".txt").write_bytes(out)
    print("recorded", c["name"], len(out))
EOF
```

Check the `alan` script's real flag syntax first with `./alan -h` and adjust the `args` line to it. Run: `wsl -d Ubuntu-20.04 -- bash tests/record_legacy.sh`. Expected: one "recorded" line per case, non-empty files for every example that prints.

- [ ] **Step 4: Write the harness**

`tests/run_examples.py`:

```python
#!/usr/bin/env python3
"""Runs every case through `alanc run` and compares with tests/expected."""
import argparse, difflib, json, pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

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
        cmd = [a.alanc, "run", str(ROOT / c["file"])] + (["-O"] if c["opt"] else [])
        stdin = (ROOT / "tests" / c["input"]).read_bytes() if c["input"] else b""
        r = subprocess.run(cmd, input=stdin, capture_output=True, timeout=120)
        want = normalize((ROOT / "tests/expected" / (c["name"] + ".txt")).read_bytes())
        got = normalize(r.stdout)
        if r.returncode == 0 and got == want:
            print("PASS", c["name"])
        else:
            failed += 1
            print("FAIL", c["name"], "exit", r.returncode)
            sys.stdout.write(r.stderr.decode("latin-1"))
            sys.stdout.writelines(difflib.unified_diff(
                want.splitlines(True), got.splitlines(True), "expected", "got"))
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 5: Confirm the harness fails today**

Run: `wsl -d Ubuntu-20.04 -- python3 tests/run_examples.py --alanc ./alanc`
Expected: every case FAIL, because `alanc run` does not exist yet.

- [ ] **Step 6: Commit**

```bash
git add tools/versions.env tests/
git commit -m "Record expected example outputs and add test harness"
```

---

### Task 2: C runtime

**Files:**
- Create: `runtime/alanrt.h`, `runtime/io.c`, `runtime/str.c`, `runtime/conv.c`, `runtime/build.sh`, `runtime/build.ps1`, `runtime/test/rt_test.c`, `runtime/test/rt_test_input.txt`, `runtime/test/rt_test_expected.txt`

**Interfaces:**
- Produces `libalanrt.a` per target with these exact symbols (types match the LLVM declarations in `ast.cpp` near line 998):

```c
void    alan_writeInteger(int32_t n);
void    alan_writeByte(uint8_t b);
void    alan_writeChar(uint8_t c);
void    alan_writeString(const char *s);
int32_t alan_readInteger(void);
uint8_t alan_readByte(void);
uint8_t alan_readChar(void);
void    alan_readString(int32_t size, char *buf);
int32_t alan_extend(uint8_t b);
uint8_t alan_shrink(int32_t n);
int32_t alan_strlen(const char *s);
int32_t alan_strcmp(const char *a, const char *b);
void    alan_strcpy(char *dst, const char *src);
void    alan_strcat(char *dst, const char *src);
```

- Build: `runtime/build.sh <zig> <target> <outdir>` and `runtime/build.ps1 -Zig <zig> -Target <target> -OutDir <dir>` produce `<outdir>/libalanrt.a`.

Behaviour copied from `alan_lib_v2` (read the .asm files when in doubt):

| Function | Behaviour |
| --- | --- |
| writeInteger | prints `(int16_t)n` in decimal, `-` for negatives, no padding |
| writeByte | prints `extend(b)` as writeInteger does |
| writeChar | writes the byte |
| writeString | writes bytes up to NUL |
| readChar | reads one byte, skipping `\n` (and `\r` so CRLF input behaves like LF) |
| readString | reads one line of at most `size - 1` bytes, strips a trailing `\n` and `\r`, NUL-terminates |
| readInteger | reads one char with readChar, then the rest of the line, parses: skip spaces, optional `-`, digits. Overflow beyond int16 gives 0. Returns the int16 value **zero-extended** (`(int32_t)(uint16_t)v`), exactly like the assembly (`mov ax, word [rsi]`) |
| readByte | `readInteger() & 0xFF` |
| extend | zero-extends a byte |
| shrink | `n & 0xFF` |
| strlen/strcmp/strcpy/strcat | C semantics, strcmp returns -1, 0 or 1 |

Every read function calls `fflush(stdout)` first.

- [ ] **Step 1: Write the failing runtime test**

`runtime/test/rt_test.c`:

```c
#include <stdio.h>
#include "../alanrt.h"

int main(void) {
    alan_writeInteger(42); alan_writeChar('\n');
    alan_writeInteger(-7); alan_writeChar('\n');
    alan_writeInteger(70000); alan_writeChar('\n');      /* int16 wrap: 4464 */
    alan_writeByte(200); alan_writeChar('\n');
    alan_writeString("hi\n");
    int32_t a = alan_readInteger();                       /* "12" */
    alan_writeInteger(a); alan_writeChar('\n');
    int32_t b = alan_readInteger();                       /* "-5" -> 65531 */
    alan_writeInteger(b); alan_writeChar('\n');
    printf("%d\n", b);
    uint8_t c = alan_readChar();                          /* skips newline, 'x' */
    alan_writeChar(c); alan_writeChar('\n');
    char buf[8];
    alan_readString(8, buf);                              /* rest of line after x: "yz" */
    alan_writeString(buf); alan_writeChar('\n');
    alan_readString(8, buf);                              /* "abcdefghij" truncated to 7 */
    alan_writeString(buf); alan_writeChar('\n');
    alan_writeInteger(alan_strlen("abc")); alan_writeChar('\n');
    alan_writeInteger(alan_strcmp("a", "b")); alan_writeChar('\n');
    char d[16]; alan_strcpy(d, "ab"); alan_strcat(d, "cd"); alan_writeString(d);
    alan_writeChar('\n');
    alan_writeInteger(alan_extend(255)); alan_writeChar('\n');
    alan_writeInteger(alan_shrink(300)); alan_writeChar('\n');
    return 0;
}
```

`runtime/test/rt_test_input.txt` (save with CRLF line endings on purpose):

```
12
-5
xyz
abcdefghij
```

`runtime/test/rt_test_expected.txt`:

```
42
-7
4464
200
hi
12
-5
65531
x
yz
abcdefg
3
-1
abcd
255
44
```

- [ ] **Step 2: Run it to see it fail**

Run (WSL): `~/tools/zig-*/zig cc -Iruntime runtime/test/rt_test.c -o /tmp/rt_test`
Expected: link errors for undefined `alan_*` symbols.

- [ ] **Step 3: Implement the runtime**

`runtime/alanrt.h` declares the 14 functions above with `#include <stdint.h>`.

`runtime/io.c`:

```c
#include <stdio.h>
#include <string.h>
#include "alanrt.h"

static int next_byte(void) { fflush(stdout); return getchar(); }

void alan_writeInteger(int32_t n) { printf("%d", (int)(int16_t)n); }
void alan_writeByte(uint8_t b) { alan_writeInteger(alan_extend(b)); }
void alan_writeChar(uint8_t c) { putchar(c); }
void alan_writeString(const char *s) { fputs(s, stdout); }

uint8_t alan_readChar(void) {
    int c;
    do { c = next_byte(); } while (c == '\n' || c == '\r');
    return c == EOF ? 0 : (uint8_t)c;
}

void alan_readString(int32_t size, char *buf) {
    int32_t n = 0;
    int c;
    fflush(stdout);
    while (n < size - 1 && (c = getchar()) != EOF && c != '\n') buf[n++] = (char)c;
    if (n > 0 && buf[n - 1] == '\r') n--;
    if (n == size - 1) {                     /* drop the rest of an over-long line */
        while ((c = getchar()) != EOF && c != '\n') {}
    }
    buf[n] = '\0';
}
```

`runtime/conv.c`:

```c
#include "alanrt.h"

static int16_t parse_int16(const char *s, int *ok) {
    while (*s == ' ') s++;
    int neg = 0;
    if (*s == '-') { neg = 1; s++; }
    int32_t v = 0;
    while (*s >= '0' && *s <= '9') {
        v = v * 10 + (*s - '0');
        if (v > 0x8000) { *ok = 0; return 0; }
        s++;
    }
    if (!neg && v > 0x7fff) { *ok = 0; return 0; }
    *ok = 1;
    return (int16_t)(neg ? -v : v);
}

int32_t alan_readInteger(void) {
    char line[256];
    line[0] = (char)alan_readChar();
    alan_readString(255, line + 1);
    int ok;
    int16_t v = parse_int16(line, &ok);
    return (int32_t)(uint16_t)v;             /* zero-extended like the assembly */
}

uint8_t alan_readByte(void) { return (uint8_t)(alan_readInteger() & 0xFF); }
int32_t alan_extend(uint8_t b) { return (int32_t)b; }
uint8_t alan_shrink(int32_t n) { return (uint8_t)(n & 0xFF); }
```

`runtime/str.c`:

```c
#include <string.h>
#include "alanrt.h"

int32_t alan_strlen(const char *s) { return (int32_t)strlen(s); }
int32_t alan_strcmp(const char *a, const char *b) {
    int r = strcmp(a, b);
    return r < 0 ? -1 : (r > 0 ? 1 : 0);
}
void alan_strcpy(char *d, const char *s) { strcpy(d, s); }
void alan_strcat(char *d, const char *s) { strcat(d, s); }
```

Note: the expected line `-5` after `12` in Step 1 is `alan_writeInteger(65531)`, which prints `(int16_t)65531 = -5`, matching the assembly.

`runtime/build.sh`:

```bash
#!/bin/sh
# usage: build.sh <zig> <target> <outdir>
set -eu
ZIG="$1"; TARGET="$2"; OUT="$3"
DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"
for f in io str conv; do
  "$ZIG" cc -target "$TARGET" -O2 -std=c17 -c "$DIR/$f.c" -o "$OUT/$f.o"
done
rm -f "$OUT/libalanrt.a"
"$ZIG" ar rcs "$OUT/libalanrt.a" "$OUT/io.o" "$OUT/str.o" "$OUT/conv.o"
rm -f "$OUT"/*.o
```

`runtime/build.ps1` does the same with `param([string]$Zig,[string]$Target,[string]$OutDir)` and `& $Zig cc ...`, `& $Zig ar rcs ...`.

- [ ] **Step 4: Run the test on Linux and Windows**

Linux (WSL):
```bash
Z=~/tools/zig-*/zig
sh runtime/build.sh $Z x86_64-linux-musl /tmp/rt
$Z cc -target x86_64-linux-musl -Iruntime runtime/test/rt_test.c /tmp/rt/libalanrt.a -o /tmp/rt_test
/tmp/rt_test < runtime/test/rt_test_input.txt | diff - runtime/test/rt_test_expected.txt
```
Windows (PowerShell):
```powershell
$Z = (Get-ChildItem D:\tools\zig-*\zig.exe).FullName
.\runtime\build.ps1 -Zig $Z -Target x86_64-windows-gnu -OutDir $env:TEMP\rt
& $Z cc -target x86_64-windows-gnu -Iruntime runtime\test\rt_test.c $env:TEMP\rt\libalanrt.a -o $env:TEMP\rt_test.exe
Get-Content runtime\test\rt_test_input.txt -Raw | & $env:TEMP\rt_test.exe | Out-File -Encoding ascii $env:TEMP\rt_out.txt
Compare-Object (Get-Content $env:TEMP\rt_out.txt) (Get-Content runtime\test\rt_test_expected.txt)
```
Expected: no diff on either platform. Also check interactively that `alan_writeString("Name? ")` followed by `alan_readString` shows the prompt before waiting (Review Focus): run `rt_test` without redirection in a terminal and confirm the first output lines appear before you type.

- [ ] **Step 5: Commit**

```bash
git add runtime/
git commit -m "Add C runtime for the Alan library"
```

---

### Task 3: Compiler symbol names, error format and check mode

**Files:**
- Modify: `ast.cpp` (the 14 `Function::Create(..., "<name>", TheModule.get())` calls between lines 998 and 1135), `parser.y:200-225` (yyerror and main), `error.cpp` (colour output)
- Create: `cli.hpp`, `cli.cpp`, `tests/errors/missing_semicolon.alan`, `tests/errors/undeclared.alan`, `tests/errors/expected.json`, `tests/run_errors.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `int alan_cli_main(int argc, char **argv)` in `cli.cpp`, called by `main` in `parser.y`. `int compile_to_module(const char *path, bool opt, bool codegen)` exported from `parser.y` (parses `path`, runs semantic checks, generates the LLVM module when `codegen` is true, returns 0 on success). `llvm::Module *alan_module()` exported from `ast.cpp` returns the generated module.
- Error output lines: `<basename>:<line>: error: <message>`.

- [ ] **Step 1: Write the failing error tests**

`tests/errors/missing_semicolon.alan`:
```
main () : proc
  x : int;
{
  x = 1
  writeInteger(x);
}
```
`tests/errors/undeclared.alan`:
```
main () : proc
{
  y = 3;
}
```
`tests/errors/expected.json`:
```json
[
  {"file": "tests/errors/missing_semicolon.alan", "line": 5, "contains": "error:"},
  {"file": "tests/errors/undeclared.alan", "line": 3, "contains": "error:"},
  {"file": "Examples/test2", "line": null, "contains": "error:"}
]
```
`tests/run_errors.py` runs `alanc check <file>` for each entry, requires exit code 1, and requires a stderr line matching `^<basename>:(\d+): error: ` whose line equals `line` (any line when null). It also requires `alanc check Examples/HelloWorld.alan` to exit 0 with empty stderr.

Before writing the expected line numbers, run the legacy compiler on both files and note which line it reports today (bison reports the line where it detects the error, which for a missing `;` is the next token's line). Use that line.

- [ ] **Step 2: Run to see it fail**

Run (WSL): `python3 tests/run_errors.py --alanc ./alanc`
Expected: FAIL, `check` is not a known command.

- [ ] **Step 3: Rename runtime symbols**

In `ast.cpp`, change only the LLVM names in the 14 `Function::Create` calls, for example:

```cpp
TheWriteInteger =
    Function::Create(writeInteger_type, Function::ExternalLinkage,
                     "alan_writeInteger", TheModule.get());
```

Do the same for writeByte, writeChar, writeString, readInteger, readByte, readChar, readString, extend, shrink, strlen, strcmp, strcpy, strcat. Leave `funLibrary[i].funName` and the `library[]` symbol table names unchanged, because they are the Alan-visible names. Legacy note: the old `alan` script links the assembly runtime, whose symbols are unprefixed. Add `--defsym`-free compatibility by keeping the old names working for the legacy script: add `-Wl,--defsym,alan_writeInteger=writeInteger` style flags for all 14 names to the link line in `alan` and `do.sh`, and check `./alan -x Examples/HelloWorld.alan` still prints "Hello world!".

- [ ] **Step 4: Error format and colours**

In `parser.y` replace `yyerror`:

```cpp
void yyerror (const char msg[]) {
  bool tty = isatty(fileno(stderr));
  fprintf(stderr, "%s:%d: %serror:%s %s\n", filename, lineno,
          tty ? "\033[1;31m" : "", tty ? "\033[0m" : "", msg);
  exit(1);
}
```

In `error.cpp`, apply the same rule to every `\033[...m` sequence: print it only when `isatty(fileno(stderr))`, and make `error()` print `error:` (lower case, followed by a space) after the `file:line: ` prefix. On Windows use `_isatty(_fileno(stderr))` from `<io.h>` behind `#ifdef _WIN32`.

- [ ] **Step 5: Command-line entry**

Move the body of `main` in `parser.y` into `compile_to_module(path, opt, codegen)` so that it opens the file, sets `filename`, parses, runs the checks, and generates IR only when `codegen` is true. `main` becomes `return alan_cli_main(argc, argv);`.

`cli.cpp` (first version, `build` and `run` come in Task 4):

```cpp
#include "cli.hpp"
#include <cstring>
#include <cstdio>
#include "llvm/Support/raw_ostream.h"

int compile_to_module(const char *path, bool opt, bool codegen);
llvm::Module *alan_module();

static int usage() {
  fprintf(stderr,
    "usage: alanc <file.alan> [-O]           print LLVM IR\n"
    "       alanc check <file.alan>          check only\n"
    "       alanc build <file.alan> [-o name] [-O]\n"
    "       alanc run <file.alan> [-O]\n");
  return 2;
}

int alan_cli_main(int argc, char **argv) {
  if (argc >= 3 && strcmp(argv[1], "check") == 0)
    return compile_to_module(argv[2], false, false);
  if (argc == 2 || (argc == 3 && strcmp(argv[2], "-O") == 0)) {
    int r = compile_to_module(argv[1], argc == 3, true);
    if (r == 0) alan_module()->print(llvm::outs(), nullptr);
    return r;
  }
  return usage();
}
```

Keep whatever the old `main` did for IR output (check whether it printed the module itself or relied on a later step) so the legacy output stays byte-identical. Verify with: `git stash; make && ./alanc Examples/BubbleSort.alan -O > /tmp/old.ll; git stash pop; make && ./alanc Examples/BubbleSort.alan -O > /tmp/new.ll; diff <(sed 's/alan_//g' /tmp/new.ll) /tmp/old.ll` (only the symbol prefix may differ).

Add `cli.o` to the `Makefile` object list.

- [ ] **Step 6: Run the tests**

Run (WSL): `make && python3 tests/run_errors.py --alanc ./alanc && ./alan -x Examples/HelloWorld.alan`
Expected: all error cases PASS, HelloWorld prints "Hello world!".

- [ ] **Step 7: Commit**

```bash
git add ast.cpp parser.y error.cpp cli.cpp cli.hpp Makefile alan do.sh tests/errors tests/run_errors.py
git commit -m "Prefix runtime symbols, unify error format and add check command"
```

---

### Task 4: Object emission, build and run

**Files:**
- Create: `emit.hpp`, `emit.cpp`
- Modify: `cli.cpp`, `Makefile`

**Interfaces:**
- Consumes: `compile_to_module`, `alan_module` (Task 3), `libalanrt.a` and `zig` (Task 2).
- Produces: `bool emit_object(llvm::Module &m, const std::string &triple, const std::string &outPath, std::string &err)` in `emit.cpp`. Tool layout that `alanc` searches relative to its own executable directory `D`: runtime at `D/../lib/libalanrt.a`, zig at `D/../zig/zig` (`zig.exe` on Windows). Environment overrides `ALAN_RUNTIME` (path to libalanrt.a) and `ALAN_ZIG` (path to zig) take priority, which is how the tests run before a bundle exists.
- `alanc run` exit status is the program's exit status. Compile errors exit 1 before running.

- [ ] **Step 1: Failing test**

Run (WSL): `ALAN_ZIG=$(ls ~/tools/zig-*/zig) ALAN_RUNTIME=/tmp/rt/libalanrt.a python3 tests/run_examples.py --alanc ./alanc`
Expected: FAIL for every case with the usage message.

- [ ] **Step 2: emit_object**

`emit.cpp`:

```cpp
#include "emit.hpp"
#include "llvm/IR/LegacyPassManager.h"
#include "llvm/MC/TargetRegistry.h"
#include "llvm/Support/FileSystem.h"
#include "llvm/Support/TargetSelect.h"
#include "llvm/Target/TargetMachine.h"
#include "llvm/Target/TargetOptions.h"
#include "llvm/TargetParser/Triple.h"

bool emit_object(llvm::Module &m, const std::string &triple,
                 const std::string &outPath, std::string &err) {
  LLVMInitializeX86TargetInfo(); LLVMInitializeX86Target();
  LLVMInitializeX86TargetMC(); LLVMInitializeX86AsmPrinter();
  LLVMInitializeAArch64TargetInfo(); LLVMInitializeAArch64Target();
  LLVMInitializeAArch64TargetMC(); LLVMInitializeAArch64AsmPrinter();
  llvm::Triple t(triple);
  const llvm::Target *target = llvm::TargetRegistry::lookupTarget(t, err);
  if (!target) return false;
  llvm::TargetOptions opts;
  const char *cpu = t.isAArch64() ? "generic" : "x86-64";
  std::unique_ptr<llvm::TargetMachine> tm(target->createTargetMachine(
      t, cpu, "", opts, llvm::Reloc::PIC_));
  m.setTargetTriple(t);
  m.setDataLayout(tm->createDataLayout());
  std::error_code ec;
  llvm::raw_fd_ostream out(outPath, ec, llvm::sys::fs::OF_None);
  if (ec) { err = ec.message(); return false; }
  llvm::legacy::PassManager pm;
  if (tm->addPassesToEmitFile(pm, out, nullptr, llvm::CodeGenFileType::ObjectFile)) {
    err = "target cannot emit object files"; return false;
  }
  pm.run(m);
  out.flush();
  return true;
}
```

Declare the `LLVMInitialize*` functions with `extern "C" void ...();` or include `llvm/Config/llvm-config.h` plus the target headers. Link the X86 and AArch64 back ends on every platform, so any `alanc` can emit code for either CPU. Check each LLVM 23 signature against the installed headers (`/usr/lib/llvm-23/include`) before compiling. `lookupTarget` and `createTargetMachine` changed argument types in recent releases. Adjust to what the headers declare.

- [ ] **Step 3: build and run commands**

Add to `cli.cpp`:

```cpp
#include "emit.hpp"
#include "llvm/Support/FileSystem.h"
#include "llvm/Support/Path.h"
#include "llvm/Support/Program.h"
#include <cstdlib>
#include <string>
#include <vector>

#if defined(_WIN32) && (defined(_M_ARM64) || defined(__aarch64__))
static const char *kTriple = "aarch64-windows-gnu";
#elif defined(_WIN32)
static const char *kTriple = "x86_64-windows-gnu";
#elif defined(__APPLE__) && defined(__aarch64__)
static const char *kTriple = "aarch64-macos";
#elif defined(__APPLE__)
static const char *kTriple = "x86_64-macos";
#elif defined(__aarch64__)
static const char *kTriple = "aarch64-linux-musl";
#else
static const char *kTriple = "x86_64-linux-musl";
#endif
#ifdef _WIN32
static const char *kExe = ".exe";
#else
static const char *kExe = "";
#endif

static std::string self_dir(const char *argv0) {
  std::string p = llvm::sys::fs::getMainExecutable(argv0, (void *)&self_dir);
  return llvm::sys::path::parent_path(p).str();
}

static std::string find_tool(const char *env, const std::string &rel, const char *argv0) {
  if (const char *e = std::getenv(env)) return e;
  llvm::SmallString<256> p(self_dir(argv0));
  llvm::sys::path::append(p, rel);
  return std::string(p);
}

static int build(const char *argv0, const char *src, const std::string &out, bool opt) {
  if (compile_to_module(src, opt, true) != 0) return 1;
  llvm::SmallString<256> obj;
  llvm::sys::fs::createTemporaryFile("alan", "o", obj);
  std::string err;
  if (!emit_object(*alan_module(), kTriple, std::string(obj), err)) {
    fprintf(stderr, "%s: error: %s\n", src, err.c_str()); return 1;
  }
  std::string zig = find_tool("ALAN_ZIG", std::string("../zig/zig") + kExe, argv0);
  std::string rt = find_tool("ALAN_RUNTIME", "../lib/libalanrt.a", argv0);
  std::vector<llvm::StringRef> args = {zig, "cc", "-target", kTriple,
                                       std::string(obj), rt, "-o", out};
  std::vector<std::string> keep(args.begin(), args.end());
  std::vector<llvm::StringRef> refs(keep.begin(), keep.end());
  int rc = llvm::sys::ExecuteAndWait(zig, refs);
  llvm::sys::fs::remove(obj);
  if (rc != 0) fprintf(stderr, "%s: error: linking failed (zig exit %d)\n", src, rc);
  return rc == 0 ? 0 : 1;
}
```

Command handling in `alan_cli_main`:
- `build <file> [-o name] [-O]`: default output is the source path with `.alan` replaced by `kExe` (or with `kExe` appended when there is no `.alan`).
- `run <file> [-O]`: build into `createTemporaryFile("alan", kExe+1 or "")`, then `ExecuteAndWait(exe, {exe})` with standard streams inherited (pass no redirects), delete the executable, return the program's exit code.

`ExecuteAndWait` takes argument vectors and handles quoting, so paths with spaces and non-ASCII characters work. Do not build a command string.

- [ ] **Step 4: Makefile and link line**

Add `emit.o` to the objects. `alanc` links LLVM statically: replace the `llvm-config --libs` call with `llvm-config --link-static --libs core support target x86 passes` and add `--system-libs`. Confirm with `ldd ./alanc` that no `libLLVM` shared object is listed.

- [ ] **Step 5: Run the harness**

Run (WSL):
```bash
make
export ALAN_ZIG=$(ls ~/tools/zig-*/zig) ALAN_RUNTIME=/tmp/rt/libalanrt.a
python3 tests/run_examples.py --alanc ./alanc
mkdir -p "/tmp/dir with space/Σάββας" && cp Examples/HelloWorld.alan "/tmp/dir with space/Σάββας/h.alan"
./alanc run "/tmp/dir with space/Σάββας/h.alan"
```
Expected: every case PASS, and the last command prints "Hello world!". Any FAIL is a runtime behaviour difference: fix `runtime/*.c`, never `tests/expected`.

- [ ] **Step 6: Commit**

```bash
git add emit.cpp emit.hpp cli.cpp Makefile
git commit -m "Add build and run commands with object emission and zig linking"
```

---

### Task 5: CMake build and compilers for all six platforms

**Files:**
- Create: `CMakeLists.txt`, `tools/build-windows.ps1`, `tools/build-linux.sh`, `tools/build-macos.sh`
- Modify: sources only where MSVC fails to compile (keep changes minimal, guard with `#ifdef _MSC_VER`)

**Interfaces:**
- Produces: `cmake -S . -B build -DLLVM_DIR=<llvm>/lib/cmake/llvm` then `cmake --build build --config Release` gives `build/alanc` or `build/Release/alanc.exe`. The Makefile remains for the course workflow.
- `tools/build-linux.sh`, `tools/build-macos.sh` and `tools/build-windows.ps1` detect the CPU (`uname -m` or `$env:PROCESSOR_ARCHITECTURE`), build `alanc` and `libalanrt.a` for the host, and write `dist/<platform>/` with layout `bin/alanc[.exe]`, `lib/libalanrt.a`, where `<platform>` is one of the six ids.

- [ ] **Step 1: CMakeLists.txt**

```cmake
cmake_minimum_required(VERSION 3.28)
project(alanc CXX)
set(CMAKE_CXX_STANDARD 17)
find_package(LLVM 23 REQUIRED CONFIG)
find_package(BISON 3.8 REQUIRED)
find_package(FLEX 2.6 REQUIRED)
BISON_TARGET(Parser parser.y ${CMAKE_BINARY_DIR}/parser.cpp DEFINES_FILE ${CMAKE_BINARY_DIR}/parser.hpp)
FLEX_TARGET(Lexer lexer.l ${CMAKE_BINARY_DIR}/lexer.cpp)
ADD_FLEX_BISON_DEPENDENCY(Lexer Parser)
add_executable(alanc ast.cpp symbol.cpp error.cpp general.cpp cli.cpp emit.cpp
               ${BISON_Parser_OUTPUTS} ${FLEX_Lexer_OUTPUTS})
target_include_directories(alanc PRIVATE ${CMAKE_SOURCE_DIR} ${CMAKE_BINARY_DIR} ${LLVM_INCLUDE_DIRS})
separate_arguments(LLVM_DEFS NATIVE_COMMAND ${LLVM_DEFINITIONS})
target_compile_definitions(alanc PRIVATE ${LLVM_DEFS})
llvm_map_components_to_libnames(LLVM_LIBS core support target passes
  x86codegen x86asmparser x86desc x86info
  aarch64codegen aarch64asmparser aarch64desc aarch64info)
target_link_libraries(alanc PRIVATE ${LLVM_LIBS})
if(MSVC)
  set_property(TARGET alanc PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded")
  target_compile_definitions(alanc PRIVATE YY_NO_UNISTD_H)
endif()
```

Check the real source file list against the Makefile and add any file it compiles that is missing here.

- [ ] **Step 2: Linux build script and check**

`tools/build-linux.sh` runs cmake with `-DLLVM_DIR=/usr/lib/llvm-23/lib/cmake/llvm`, builds, runs `runtime/build.sh` for `x86_64-linux-musl`, copies into `dist/linux-x64/bin` and `dist/linux-x64/lib`.

Run (WSL): `bash tools/build-linux.sh && ALAN_ZIG=$(ls ~/tools/zig-*/zig) ALAN_RUNTIME=dist/linux-x64/lib/libalanrt.a python3 tests/run_examples.py --alanc dist/linux-x64/bin/alanc`
Expected: all PASS.

- [ ] **Step 3: Windows builds in CI (x64 and ARM64)**

Windows has no local MSVC on the developer machine, so this step is verified in CI. `tools/build-windows.ps1`:
1. Picks `x86_64` or `aarch64` from `$env:PROCESSOR_ARCHITECTURE` (`AMD64` or `ARM64`) and downloads `clang+llvm-23.1.2-<arch>-pc-windows-msvc.tar.xz` from the llvm-project `llvmorg-23.1.2` release into `$env:RUNNER_TEMP`, then extracts it.
2. Installs win_flex_bison with `choco install winflexbison3 -y`. If Chocolatey is missing on the ARM64 runner, download the win_flex_bison zip from its GitHub release instead (it is x64 and runs under emulation).
3. Runs cmake with `-G "Visual Studio 17 2022" -A x64` or `-A ARM64`, `-DLLVM_DIR=<extract>/lib/cmake/llvm -DBISON_EXECUTABLE=win_bison.exe -DFLEX_EXECUTABLE=win_flex.exe`, builds Release.
4. Builds the runtime for `x86_64-windows-gnu` or `aarch64-windows-gnu` with `runtime/build.ps1`.
5. Copies into `dist/windows-x64/` or `dist/windows-arm64/`.

- [ ] **Step 4: Linux ARM64 and macOS builds in CI**

- Linux ARM64: `tools/build-linux.sh` downloads `LLVM-23.1.2-Linux-ARM64.tar.xz` when `uname -m` is `aarch64` (and `LLVM-23.1.2-Linux-X64.tar.xz` on x64 in CI, where apt.llvm.org is not needed), and uses `-DLLVM_DIR` from the extracted folder. Runtime target `aarch64-linux-musl`.
- `tools/build-macos.sh`: on `arm64` downloads `LLVM-23.1.2-macOS-ARM64.tar.xz`. On `x86_64` runs `brew install llvm@23 bison flex` (fall back to `brew install llvm` when it is version 23) and uses `$(brew --prefix llvm@23)/lib/cmake/llvm` and Homebrew's bison. Runtime target `aarch64-macos` or `x86_64-macos`. Set `CMAKE_OSX_DEPLOYMENT_TARGET=12.0`. Check with `otool -L build/alanc` that only system libraries are linked (no Homebrew paths).

Add a temporary matrix job `build` in `.github/workflows/ci.yml` (Task 6 finishes that file) over the six runners in the Global Constraints. Each runs its build script and then:

```sh
ALAN_ZIG=<zig path> ALAN_RUNTIME=dist/<platform>/lib/libalanrt.a python3 tests/run_examples.py --alanc dist/<platform>/bin/alanc
ALAN_ZIG=<zig path> ALAN_RUNTIME=dist/<platform>/lib/libalanrt.a python3 tests/run_errors.py --alanc dist/<platform>/bin/alanc
```

Push the branch and iterate until all six pass. Fix compile errors in the sources with the smallest possible change. If the example output differs on ARM64, the cause is in the runtime or in code that assumed x86 (for example `char` signedness, which is unsigned on AArch64 Linux): fix it in the source so all platforms match `tests/expected`.

- [ ] **Step 5: Commit**

```bash
git add CMakeLists.txt tools/ .github/workflows/ci.yml <any source fixes>
git commit -m "Add CMake build for Windows, Linux and macOS on x64 and ARM64"
```

---

### Task 6: Bundles, CI and compiler release

**Files:**
- Create: `tools/package.py`, `.github/workflows/ci.yml` (complete), `bundle-README.txt`
- Replace: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `dist/<platform>/` from Task 5, zig version from `tools/versions.env`.
- Produces: `python tools/package.py --platform <platform id> --version v2.0.0 --zig <zig dir>` writes `out/alan-v2.0.0-<platform>.zip` (Windows) or `.tar.gz` (Linux, macOS) with layout:

```
alan/
  bin/alanc[.exe]
  lib/libalanrt.a
  zig/            (the whole Zig distribution folder: zig[.exe] and lib/)
  README.txt
  VERSION         (e.g. v2.0.0)
```

- [ ] **Step 1: package.py**

```python
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
    (stage / "VERSION").write_text(a.version + "\n")
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
```

Check that the Linux tarball keeps the executable bits of `bin/alanc` and `zig/zig`.

`bundle-README.txt` explains: add `alan/bin` to PATH, then `alanc run file.alan`. It lists the commands and says the bundled Zig is only used to link.

- [ ] **Step 2: ci.yml**

Jobs on push and pull_request:
- `compiler`: a matrix over the six platforms, each on its runner from the Global Constraints (Linux jobs use the `ubuntu:20.04` container for their CPU). Each installs bison 3.8.2 (from source on Linux), flex, cmake (pip on Linux), python3 and Zig 0.16.0 for that platform, runs its build script, `tests/run_examples.py`, `tests/run_errors.py`, then packages and smoke-tests the archive: extract it and run `alan/bin/alanc run Examples/HelloWorld.alan` without `ALAN_ZIG`/`ALAN_RUNTIME` set. Upload the archive as an artifact.
- `vscode`: added in Task 19.

Use the current major versions of `actions/checkout`, `actions/setup-python`, `actions/upload-artifact`.

- [ ] **Step 3: release.yml**

On `v*` tags: run the same six-platform matrix, package and smoke-test each bundle, then a final job downloads the six artifacts, computes `SHA256SUMS` over them (`sha256sum alan-* > SHA256SUMS`), and publishes all seven files with `softprops/action-gh-release` at its current major version. Release notes: two or three plain sentences with install one-liners. Keep the old v1.0.0 release untouched.

- [ ] **Step 4: Verify in CI**

Push. Expected: `ci.yml` green on all six platforms. Then `git tag v2.0.0-rc.1 && git push origin v2.0.0-rc.1`, confirm the release job publishes seven assets as a prerelease, download the Windows x64 and Linux x64 bundles with `gh release download v2.0.0-rc.1`, and run `alan/bin/alanc run Examples/HelloWorld.alan` from each locally (Windows natively, Linux in WSL). The other four are covered by their CI smoke tests. Then delete the rc release and tag: `gh release delete v2.0.0-rc.1 --cleanup-tag -y`.

- [ ] **Step 5: Commit**

```bash
git add tools/package.py bundle-README.txt .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "Package self-contained bundles and release them with checksums"
```

---

### Task 7: Install scripts

**Files:**
- Create: `install/install.sh`, `install/install.ps1`
- Modify: `.github/workflows/ci.yml` (installer test steps), `README.md` (Install section)

**Interfaces:**
- Both scripts accept an optional version (`ALAN_VERSION` env var, default latest) and an optional base URL (`ALAN_BASE_URL`, default `https://github.com/sleousis/alan-compiler/releases`), so CI can point them at a local server.
- Latest version lookup: `https://api.github.com/repos/sleousis/alan-compiler/releases/latest` field `tag_name`.

- [ ] **Step 1: install.sh**

```sh
#!/bin/sh
# Installs the Alan compiler to ~/.local/share/alan and links alanc into ~/.local/bin.
set -eu
BASE="${ALAN_BASE_URL:-https://github.com/sleousis/alan-compiler/releases}"
VER="${ALAN_VERSION:-}"
if [ -z "$VER" ]; then
  VER=$(curl -fsSL https://api.github.com/repos/sleousis/alan-compiler/releases/latest \
        | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)
fi
[ -n "$VER" ] || { echo "Could not find the latest Alan release." >&2; exit 1; }
case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=macos ;;
  *) echo "Unsupported system $(uname -s). Use install.ps1 on Windows." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "Unsupported CPU $(uname -m)." >&2; exit 1 ;;
esac
NAME="alan-$VER-$OS-$ARCH.tar.gz"
if command -v sha256sum >/dev/null; then SHA="sha256sum"; else SHA="shasum -a 256"; fi
TMP=$(mktemp -d); trap 'rm -rf "$TMP" "$HOME/.local/share/alan.new"' EXIT
curl -fsSL "$BASE/download/$VER/$NAME" -o "$TMP/$NAME" \
  || { echo "Could not download $NAME. Check your connection." >&2; exit 1; }
curl -fsSL "$BASE/download/$VER/SHA256SUMS" -o "$TMP/SHA256SUMS"
( cd "$TMP" && grep " $NAME\$" SHA256SUMS | $SHA -c - ) >/dev/null \
  || { echo "Checksum mismatch for $NAME. Nothing was installed." >&2; exit 1; }
DEST="$HOME/.local/share/alan"
rm -rf "$DEST.new"; mkdir -p "$DEST.new"
tar -xzf "$TMP/$NAME" -C "$DEST.new" --strip-components=1
[ "$OS" = macos ] && xattr -dr com.apple.quarantine "$DEST.new" 2>/dev/null || true
rm -rf "$DEST"; mv "$DEST.new" "$DEST"
mkdir -p "$HOME/.local/bin"
ln -sf "$DEST/bin/alanc" "$HOME/.local/bin/alanc"
echo "Installed Alan $VER. Run: alanc run hello.alan"
echo "To uninstall: rm -rf \"$DEST\" \"$HOME/.local/bin/alanc\""
```

- [ ] **Step 2: install.ps1**

Same flow in PowerShell. Pick `windows-arm64` when `[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture` is `Arm64`, otherwise `windows-x64`. `Invoke-RestMethod` for the latest tag, `Invoke-WebRequest` for the zip and `SHA256SUMS`, `Get-FileHash -Algorithm SHA256` compared case-insensitively with the matching line, extract with `Expand-Archive` to `$env:LOCALAPPDATA\alan.new`, swap into `$env:LOCALAPPDATA\alan`, then add `$env:LOCALAPPDATA\alan\bin` to the user PATH with `[Environment]::SetEnvironmentVariable("Path", ..., "User")` only when it is not already present. Print the uninstall steps. Stop with a clear message on any failure, and remove the `.new` folder in a `finally` block.

- [ ] **Step 3: CI test**

In `ci.yml`, in every matrix job after packaging, serve `out/` with `python -m http.server` laid out as `download/<ver>/<files>` (with a `SHA256SUMS` for that one archive), run the platform's installer with `ALAN_BASE_URL=http://127.0.0.1:8000 ALAN_VERSION=v0.0.0-ci`, then run the installed `alanc run Examples/HelloWorld.alan` from a new shell (Windows: read the user PATH from the registry for the new shell). Also run once with a corrupted archive and assert exit code 1 and no `alan` folder left.

- [ ] **Step 4: README Install section**

Add to `README.md` an "Install" section with the two one-liners:

```
Windows (PowerShell):  irm https://raw.githubusercontent.com/sleousis/alan-compiler/master/install/install.ps1 | iex
Linux and macOS:       curl -fsSL https://raw.githubusercontent.com/sleousis/alan-compiler/master/install/install.sh | sh
```

and the `alanc run`, `build`, `check` usage.

- [ ] **Step 5: Commit**

```bash
git add install/ .github/workflows/ci.yml README.md
git commit -m "Add one-line installers for Windows, Linux and macOS"
```

---

### Task 8: Extension scaffold, grammar and snippets

**Files:**
- Create: `vscode/package.json`, `vscode/tsconfig.json`, `vscode/esbuild.mjs`, `vscode/.vscodeignore`, `vscode/language-configuration.json`, `vscode/syntaxes/alan.tmLanguage.json`, `vscode/snippets/alan.json`, `vscode/test/grammar/*.alan`, `vscode/icon.png`

**Interfaces:**
- Produces: language id `alan`, file extension `.alan`, scope name `source.alan`. Build: `npm run build` bundles `src/client/extension.ts` to `dist/extension.js` and `src/server/server.ts` to `dist/server.js`. Tests: `npm test` (unit, mocha + ts-node), `npm run test:grammar`, `npm run test:e2e`.

- [ ] **Step 1: package.json**

Key fields (fill `engines.vscode` with the current stable VS Code version at the time, as `^1.<minor>.0`, and `version` `1.0.0`):

```json
{
  "name": "alan",
  "displayName": "Alan",
  "description": "Alan language support: highlighting, live errors, completion and one-click run.",
  "publisher": "sleousis",
  "license": "SEE LICENSE IN LICENSE",
  "repository": {"type": "git", "url": "https://github.com/sleousis/alan-compiler"},
  "icon": "icon.png",
  "categories": ["Programming Languages", "Linters", "Snippets"],
  "main": "./dist/extension.js",
  "activationEvents": [],
  "contributes": {
    "languages": [{"id": "alan", "aliases": ["Alan"], "extensions": [".alan"],
                   "configuration": "./language-configuration.json"}],
    "grammars": [{"language": "alan", "scopeName": "source.alan", "path": "./syntaxes/alan.tmLanguage.json"}],
    "snippets": [{"language": "alan", "path": "./snippets/alan.json"}],
    "commands": [
      {"command": "alan.run", "title": "Alan: Run", "icon": "$(play)"},
      {"command": "alan.build", "title": "Alan: Build"},
      {"command": "alan.showIr", "title": "Alan: Show IR"},
      {"command": "alan.install", "title": "Alan: Install or Update Compiler"},
      {"command": "alan.uninstall", "title": "Alan: Remove Installed Compiler"}
    ],
    "menus": {"editor/title/run": [{"command": "alan.run", "when": "editorLangId == alan"}]},
    "configuration": {"title": "Alan", "properties": {
      "alan.compilerPath": {"type": "string", "default": "", "description": "Path to alanc. Empty means the installed copy or alanc on PATH."},
      "alan.optimize": {"type": "boolean", "default": true, "description": "Pass -O to the compiler."},
      "alan.useWsl": {"type": "boolean", "default": false, "description": "On Windows, install and run the compiler inside WSL."},
      "alan.checkOnSave": {"type": "boolean", "default": true, "description": "Run alanc check when a file is saved."}
    }},
    "taskDefinitions": [{"type": "alan", "required": ["file"], "properties": {"file": {"type": "string"}}}]
  }
}
```

The repository has no license file. Ask the user which license to use before publishing (Task 19). Until then keep `"license": "UNLICENSED"` and `"private": true` so `vsce` does not publish by accident.

- [ ] **Step 2: Grammar**

`syntaxes/alan.tmLanguage.json` patterns, in this order:
- `comment.block.alan`: begin `\(\*`, end `\*\)`, with `"patterns": [{"include": "#blockComment"}]` for nesting.
- `comment.line.double-dash.alan`: `--.*$`.
- `string.quoted.double.alan`: begin `"`, end `"`, escapes `constant.character.escape.alan` matching `\\(n|t|r|0|\\|'|"|x[0-9a-fA-F]{2})`.
- `constant.character.alan`: `'(\\(n|t|r|0|\\|'|"|x[0-9a-fA-F]{2})|[^'\\])'`.
- `constant.numeric.integer.alan`: `\b[0-9]+\b`.
- `keyword.control.alan`: `\b(if|else|while|return)\b`.
- `storage.type.alan`: `\b(int|byte|proc)\b`, `storage.modifier.alan`: `\breference\b`.
- `constant.language.boolean.alan`: `\b(true|false)\b`.
- `entity.name.function.alan` for declarations: `^\s*([A-Za-z][A-Za-z0-9_]*)\s*(?=\()` when followed later by `:`. Simplest reliable rule: a name followed by `(` at the start of a line.
- `support.function.alan`: the 14 library names followed by `(`.
- `keyword.operator.alan`: `==|!=|<=|>=|[+\-*/%<>=!&|]`.

`language-configuration.json`: line comment `--`, block comment `(*` `*)`, brackets `{}` `[]` `()`, auto-closing pairs for those plus `"` and `'`.

- [ ] **Step 3: Grammar tests**

Use `vscode-tmgrammar-test`. `test/grammar/basics.alan`:

```
-- SYNTAX TEST "source.alan" "basics"
main () : proc
-- <---- entity.name.function.alan
  x : int;
--    ^^^ storage.type.alan
{
  (* outer (* nested *) still comment *)
--                      ^^^^^ comment.block.alan
  writeString("a\n");
--^^^^^^^^^^^ support.function.alan
--                ^^ constant.character.escape.alan
  if (x == 'b') return;
--^^ keyword.control.alan
--         ^^^ constant.character.alan
}
```

Run: `npm run test:grammar`. Expected before the grammar exists: FAIL. After: PASS.

- [ ] **Step 4: Snippets**

`snippets/alan.json` with `func` (`${1:name} (${2}) : ${3|proc,int,byte|}\n{\n\t$0\n}`), `if`, `ifelse`, `while`.

- [ ] **Step 5: Commit**

```bash
git add vscode/
git commit -m "Add VS Code extension scaffold, grammar and snippets"
```

---

### Task 9: Lexer

**Files:**
- Create: `vscode/src/server/lexer.ts`, `vscode/test/unit/lexer.test.ts`

**Interfaces:**
- Produces:

```ts
export type TokenKind =
  | "id" | "int" | "char" | "string"
  | "kw_if" | "kw_else" | "kw_while" | "kw_return" | "kw_int" | "kw_byte"
  | "kw_reference" | "kw_proc" | "kw_true" | "kw_false"
  | "==" | "!=" | "<=" | ">=" | "=" | "!" | "|" | "&" | "<" | ">" | "(" | ")"
  | "[" | "]" | "{" | "}" | "," | ":" | "+" | "-" | "*" | "%" | "/" | ";"
  | "eof" | "bad";
export interface Pos { line: number; character: number; }        // 0-based, LSP style
export interface Range { start: Pos; end: Pos; }
export interface Token { kind: TokenKind; text: string; range: Range; }
export interface LexError { message: string; range: Range; }
export function lex(src: string): { tokens: Token[]; errors: LexError[] };
```

Rules copied from `lexer.l`: whitespace is space, tab, `\r`, `\n`. `--` to end of line is a comment. `(*` starts a nested comment (depth counter). Identifiers `[A-Za-z][A-Za-z0-9_]*`. Integers `[0-9]+`. A digit run followed directly by a letter is one `bad` token with error "Illegal phrase". Strings `"` with `\\.` escapes, no newline inside. Char literals as in the grammar. Unterminated string, char or comment gives an error at its start. Any other character is a `bad` token with error "Illegal character".

- [ ] **Step 1: Failing tests**

```ts
import { strict as assert } from "assert";
import { lex } from "../../src/server/lexer";

describe("lexer", () => {
  it("lexes keywords, ids, numbers and operators", () => {
    const k = lex("main () : proc x == 10 != y").tokens.map(t => t.kind);
    assert.deepEqual(k, ["id","(",")",":","kw_proc","id","==","int","!=","id","eof"]);
  });
  it("skips nested comments and line comments", () => {
    const r = lex("(* a (* b *) c *) x -- y\nz");
    assert.deepEqual(r.tokens.map(t => t.text), ["x","z",""]);
    assert.equal(r.errors.length, 0);
  });
  it("tracks positions with CRLF", () => {
    const t = lex("a\r\n  b").tokens[1];
    assert.deepEqual(t.range.start, { line: 1, character: 2 });
  });
  it("reads char and string literals with escapes", () => {
    const k = lex(`'\\n' '\\x4f' "a\\"b"`).tokens.map(t => t.kind);
    assert.deepEqual(k, ["char","char","string","eof"]);
  });
  it("reports unterminated comment and illegal phrase", () => {
    assert.match(lex("(* open").errors[0].message, /comment/);
    assert.match(lex("12abc").errors[0].message, /Illegal phrase/);
  });
});
```

- [ ] **Step 2: Run to fail**

Run: `cd vscode && npx mocha -r ts-node/register test/unit/lexer.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `lexer.ts`**

A single pass over `src` with index `i`, `line`, `col`. Advance `line` and reset `col` on `\n` only (so `\r` is just whitespace). Map keyword texts through a `Record<string, TokenKind>`. Check two-character operators before one-character ones. For `(*`, keep a depth counter and look for `(*` and `*)` until depth 0 or end of file.

- [ ] **Step 4: Run to pass**

Same command. Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/server/lexer.ts vscode/test/unit/lexer.test.ts
git commit -m "Add Alan lexer for the language server"
```

---

### Task 10: Parser and syntax tree

**Files:**
- Create: `vscode/src/server/ast.ts`, `vscode/src/server/parser.ts`, `vscode/test/unit/parser.test.ts`

**Interfaces:**
- Consumes: `lex`, `Token`, `Range` (Task 9).
- Produces:

```ts
// ast.ts
import { Range } from "./lexer";
export type DataType = "int" | "byte";
export interface TypeRef { base: DataType; array: boolean; range: Range; }
export interface Param { name: string; nameRange: Range; byRef: boolean; type: TypeRef; }
export interface VarDecl { kind: "var"; name: string; nameRange: Range; type: DataType; size?: number; range: Range; }
export interface FuncDecl {
  kind: "func"; name: string; nameRange: Range; params: Param[];
  ret: DataType | "proc"; locals: (FuncDecl | VarDecl)[]; body: Block; range: Range;
}
export interface Block { kind: "block"; stmts: Stmt[]; range: Range; }
export type Stmt =
  | { kind: "empty"; range: Range }
  | { kind: "assign"; target: LValue; value: Expr; range: Range }
  | Block
  | { kind: "call"; call: Call; range: Range }
  | { kind: "if"; cond: Cond; then: Stmt; else?: Stmt; range: Range }
  | { kind: "while"; cond: Cond; body: Stmt; range: Range }
  | { kind: "return"; value?: Expr; range: Range };
export type LValue =
  | { kind: "name"; name: string; range: Range }
  | { kind: "index"; name: string; nameRange: Range; index: Expr; range: Range }
  | { kind: "string"; value: string; range: Range };
export interface Call { kind: "call"; name: string; nameRange: Range; args: Expr[]; range: Range; }
export type Expr =
  | { kind: "int"; value: number; range: Range }
  | { kind: "char"; text: string; range: Range }
  | LValue | Call
  | { kind: "unary"; op: "+" | "-"; operand: Expr; range: Range }
  | { kind: "binary"; op: "+" | "-" | "*" | "/" | "%"; left: Expr; right: Expr; range: Range };
export type Cond =
  | { kind: "bool"; value: boolean; range: Range }
  | { kind: "not"; operand: Cond; range: Range }
  | { kind: "compare"; op: "==" | "!=" | "<" | ">" | "<=" | ">="; left: Expr; right: Expr; range: Range }
  | { kind: "logic"; op: "&" | "|"; left: Cond; right: Cond; range: Range };
export interface Diagnostic { message: string; range: Range; severity: "error" | "warning"; source: "alan"; }

// parser.ts
export function parse(src: string): { program?: FuncDecl; diagnostics: Diagnostic[] };
```

Grammar (from `parser.y`), written for recursive descent:

```
program     = funcDef EOF
funcDef     = id "(" [param {"," param}] ")" ":" (dataType | "proc") {localDef} block
param       = id ":" ["reference"] dataType ["[" "]"]
localDef    = funcDef | varDef           (both start with id; varDef has ":" after id, funcDef has "(")
varDef      = id ":" dataType ["[" int "]"] ";"
block       = "{" {stmt} "}"
stmt        = ";" | block | "if" "(" cond ")" stmt ["else" stmt] | "while" "(" cond ")" stmt
            | "return" [expr] ";" | id "(" args ")" ";" | lvalue "=" expr ";"
lvalue      = id ["[" expr "]"] | string
expr        = term {("+"|"-") term}
term        = unary {("*"|"/"|"%") unary}
unary       = ("+"|"-") unary | primary
primary     = int | char | "(" expr ")" | id "(" args ")" | lvalue
cond        = andCond {"|" andCond}
andCond     = notCond {"&" notCond}
notCond     = "!" notCond | condAtom
condAtom    = "true" | "false" | "(" cond ")" | expr relop expr
```

`&` and `|` are left-associative with `&` binding tighter, matching the `%left` order in `parser.y`. The `(` ambiguity in `condAtom`: save the token index, try `"(" cond ")"`, and if the token after the closing `)` is a relational or arithmetic operator, or the inner parse failed, rewind and parse `expr relop expr` instead.

Error recovery: on an unexpected token, report "expected X but found Y" at that token, then skip to the next `;`, `}` or token that can start a statement or declaration, and continue. Never report more than one error at the same position. Missing `;` is reported at the end of the previous token (range of zero width), which is where a person expects the squiggle.

- [ ] **Step 1: Failing tests**

```ts
import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { parse } from "../../src/server/parser";

const ex = path.resolve(__dirname, "../../../Examples");

describe("parser", () => {
  for (const f of fs.readdirSync(ex).filter(f => f.endsWith(".alan"))) {
    it(`parses ${f} without errors`, () => {
      const r = parse(fs.readFileSync(path.join(ex, f), "utf8"));
      assert.deepEqual(r.diagnostics, []);
      assert.ok(r.program);
    });
  }
  it("reports a missing semicolon at the end of the statement", () => {
    const r = parse("main () : proc\n x : int;\n{\n  x = 1\n  x = 2;\n}");
    assert.equal(r.diagnostics.length, 1);
    assert.equal(r.diagnostics[0].range.start.line, 3);
    assert.match(r.diagnostics[0].message, /';'/);
  });
  it("keeps going after an error", () => {
    const r = parse("main () : proc\n{\n  x = ;\n  y = ;\n}");
    assert.equal(r.diagnostics.length, 2);
  });
  it("parses parenthesised conditions and expressions", () => {
    const r = parse("m () : proc\n x : int;\n{ if ((x + 1) * 2 > 3 & !(x == 0) | true) ; }");
    assert.deepEqual(r.diagnostics, []);
  });
  it("parses nested functions", () => {
    const r = parse("a () : proc\n b (x : reference int, y : byte[]) : int\n { return x; }\n{ }");
    assert.equal(r.program!.locals[0].kind, "func");
  });
});
```

`Examples/test2` and `Examples/test` have no `.alan` extension and are covered in Task 11.

- [ ] **Step 2: Run to fail**

Run: `npx mocha -r ts-node/register test/unit/parser.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `ast.ts` and `parser.ts`**

A `Parser` class holding `tokens`, `pos`, `diagnostics`, with helpers `peek(k = 0)`, `at(kind)`, `eat(kind): Token | undefined`, `expect(kind, what): Token | undefined` (reports and returns undefined), `sync(stopKinds)`. One method per grammar rule above, each returning its node with a range from its first to its last token. `localDef` decides between function and variable by looking at the token after the id: `(` means function, `:` means variable.

- [ ] **Step 4: Run to pass**

Expected: every example passes and the four targeted tests pass.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/server/ast.ts vscode/src/server/parser.ts vscode/test/unit/parser.test.ts
git commit -m "Add Alan parser with error recovery"
```

---

### Task 11: Scopes, library and name checks

**Files:**
- Create: `vscode/src/server/library.ts`, `vscode/src/server/scopes.ts`, `vscode/test/unit/scopes.test.ts`

**Interfaces:**
- Consumes: `parse`, AST types (Task 10).
- Produces:

```ts
// library.ts
export interface LibFunc { name: string; params: { name: string; type: string }[]; ret: string; doc: string; }
export const LIBRARY: LibFunc[];   // the 14 functions, signatures as Alan text
export function signature(f: { name: string; params: { name: string; type: string }[]; ret: string }): string;
// e.g. "readString (n : int, s : reference byte[]) : proc"

// scopes.ts
import { Range } from "./lexer";
export type SymbolKind = "function" | "parameter" | "variable" | "library";
export interface Sym { name: string; kind: SymbolKind; typeText: string; range?: Range; params?: { name: string; type: string }[]; decl?: import("./ast").FuncDecl | import("./ast").VarDecl; }
export interface Scope { owner?: import("./ast").FuncDecl; parent?: Scope; symbols: Map<string, Sym>; children: Scope[]; range: Range; }
export interface Analysis { root: Scope; diagnostics: import("./ast").Diagnostic[]; references: { name: string; range: Range; target?: Sym }[]; }
export function analyze(program: import("./ast").FuncDecl): Analysis;
export function scopeAt(root: Scope, pos: import("./lexer").Pos): Scope;
export function visible(scope: Scope): Sym[];   // innermost first, shadowed names removed
```

Library signatures (Alan text, from `ast.cpp` library table):

| name | params | ret |
| --- | --- | --- |
| writeInteger | n : int | proc |
| writeByte | b : byte | proc |
| writeChar | b : byte | proc |
| writeString | s : reference byte[] | proc |
| readInteger | | int |
| readByte | | byte |
| readChar | | byte |
| readString | n : int, s : reference byte[] | proc |
| extend | b : byte | int |
| shrink | i : int | byte |
| strlen | s : reference byte[] | int |
| strcmp | s1 : reference byte[], s2 : reference byte[] | int |
| strcpy | trg : reference byte[], src : reference byte[] | proc |
| strcat | trg : reference byte[], src : reference byte[] | proc |

Check the parameter names against the `library[i]->u.eFunction.firstArgument->id` strings in `ast.cpp` and use those.

Scoping rule (Alan, like the compiler): a function's name is visible in its enclosing scope and inside itself. Parameters and locals are visible in the function body and in nested functions declared after them. The library lives in an outer root scope.

Checks: undeclared name (error "Unknown name 'x'"), duplicate name in one scope ("'x' is already declared in this scope"), wrong argument count ("'f' expects 2 arguments but got 3"), calling a variable, indexing a non-array.

- [ ] **Step 1: Failing tests**

```ts
import { strict as assert } from "assert";
import * as fs from "fs"; import * as path from "path";
import { parse } from "../../src/server/parser";
import { analyze, scopeAt, visible } from "../../src/server/scopes";

const run = (s: string) => analyze(parse(s).program!);

describe("scopes", () => {
  it("finds undeclared names", () => {
    const a = run("m () : proc\n{ y = 1; }");
    assert.match(a.diagnostics[0].message, /Unknown name 'y'/);
  });
  it("finds duplicates and wrong argument counts", () => {
    const a = run("m () : proc\n x : int;\n x : byte;\n{ writeInteger(1, 2); }");
    const msgs = a.diagnostics.map(d => d.message).join("\n");
    assert.match(msgs, /already declared/);
    assert.match(msgs, /expects 1 argument/);
  });
  it("lists visible names at a position, innermost first", () => {
    const src = "m () : proc\n a : int;\n f (b : int) : proc\n  c : int;\n { c = b; }\n{ }";
    const a = run(src);
    const names = visible(scopeAt(a.root, { line: 4, character: 4 })).map(s => s.name);
    assert.deepEqual(names.slice(0, 5), ["c", "b", "f", "a", "m"]);
    assert.ok(names.includes("writeInteger"));
  });
  it("reports the errors in Examples/test2", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../../Examples/test2"), "utf8");
    const p = parse(src);
    const d = p.program ? analyze(p.program).diagnostics : [];
    assert.ok(p.diagnostics.length + d.length > 0);
  });
});
```

- [ ] **Step 2: Run to fail**, then **Step 3: implement** `library.ts` (the table above plus one-line docs such as "Prints an integer.") and `scopes.ts` (walk the tree, push a scope per function, resolve every name use in statements and expressions, record `references` for go to definition), then **Step 4: run to pass**.

Run: `npx mocha -r ts-node/register test/unit/scopes.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/server/library.ts vscode/src/server/scopes.ts vscode/test/unit/scopes.test.ts
git commit -m "Add scopes, library signatures and name checks"
```

---

### Task 12: Language server features

**Files:**
- Create: `vscode/src/server/server.ts`, `diagnostics.ts`, `completion.ts`, `hover.ts`, `symbols.ts`, `vscode/test/unit/features.test.ts`

**Interfaces:**
- Consumes: `parse`, `analyze`, `scopeAt`, `visible`, `LIBRARY`, `signature`.
- Produces pure functions (tested without a running server) and the server that registers them:

```ts
export function computeDiagnostics(src: string): Diagnostic[];                       // parse + analyze
export function completions(src: string, pos: Pos): { label: string; kind: "keyword" | "function" | "variable" | "parameter" | "library" | "snippet"; detail?: string; documentation?: string; insertText?: string }[];
export function hover(src: string, pos: Pos): string | undefined;                    // markdown
export function signatureHelp(src: string, pos: Pos): { label: string; activeParameter: number } | undefined;
export function definition(src: string, pos: Pos): Range | undefined;
export function documentSymbols(src: string): { name: string; kind: "function" | "variable"; range: Range; selectionRange: Range; children: any[] }[];
```

The server keeps the last good analysis per document, so completion still works while the current text has a syntax error. It re-analyses on every change with a 150 ms debounce. It merges live diagnostics with compiler diagnostics received from the client through a custom notification `alan/compilerDiagnostics` `{ uri, diagnostics }`, dropping compiler diagnostics on a line that already has a live one.

- [ ] **Step 1: Failing tests**

```ts
import { strict as assert } from "assert";
import { completions, hover, signatureHelp, definition, documentSymbols } from "../../src/server/server";

const src = "m () : proc\n total : int;\n add (a : int, b : int) : int\n { return a + b; }\n{\n  total = add(1, 2);\n  \n}";

describe("features", () => {
  it("completes keywords, locals, functions and library", () => {
    const labels = completions(src, { line: 6, character: 2 }).map(c => c.label);
    for (const l of ["total", "add", "m", "writeInteger", "while", "if"]) assert.ok(labels.includes(l), l);
  });
  it("hovers a function with its signature", () => {
    assert.match(hover(src, { line: 5, character: 11 })!, /add \(a : int, b : int\) : int/);
  });
  it("shows signature help with the active parameter", () => {
    const s = signatureHelp(src, { line: 5, character: 16 })!;
    assert.equal(s.activeParameter, 1);
  });
  it("goes to the definition", () => {
    assert.equal(definition(src, { line: 5, character: 3 })!.start.line, 1);
  });
  it("outlines nested functions", () => {
    const d = documentSymbols(src);
    assert.equal(d[0].name, "m");
    assert.ok(d[0].children.some((c: any) => c.name === "add"));
  });
});
```

- [ ] **Step 2: Run to fail.** `npx mocha -r ts-node/register test/unit/features.test.ts`, expected FAIL.

- [ ] **Step 3: Implement** the pure functions in their own files and export them from `server.ts`, which also creates the connection with `createConnection(ProposedFeatures.all)`, a `TextDocuments` manager, and registers `onCompletion`, `onHover`, `onSignatureHelp`, `onDefinition`, `onDocumentSymbol` and diagnostics publishing. Keywords offered: `if else while return int byte reference proc true false`. Library items carry `detail` = `signature(...)` and `documentation` = the doc line.

- [ ] **Step 4: Run to pass.** Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/server vscode/test/unit/features.test.ts
git commit -m "Add completion, hover, signature help, definition and outline"
```

---

### Task 13: Compiler integration, commands and WSL mode

**Files:**
- Create: `vscode/src/client/extension.ts`, `compiler.ts`, `commands.ts`, `wsl.ts`, `vscode/src/server/compilerCheck.ts`, `vscode/test/unit/compiler.test.ts`

**Interfaces:**
- Consumes: server (Task 12), installer (Task 14 provides `installedCompilerPath(context): string | undefined`, stubbed here as returning undefined until Task 14).
- Produces:

```ts
// compiler.ts
export interface CompilerRef { exe: string; wsl: boolean; }
export async function findCompiler(ctx: vscode.ExtensionContext): Promise<CompilerRef | undefined>;
export function parseCompilerOutput(stderr: string, fileBase: string): { line: number; message: string }[];  // 0-based lines
export function commandLine(c: CompilerRef, verb: "check" | "build" | "run", file: string, opts: { optimize: boolean; out?: string }): { cmd: string; args: string[] };
// wsl.ts
export function toWslPath(winPath: string): string;   // C:\a b\x.alan -> /mnt/c/a b/x.alan
```

`commandLine` for WSL returns `{ cmd: "wsl.exe", args: ["--", "alanc", verb, toWslPath(file), ...] }` where `alanc` resolves through `~/.local/bin` (use `bash -lc` only if needed, and quote nothing: arguments go as an array).

- [ ] **Step 1: Failing tests**

```ts
import { strict as assert } from "assert";
import { parseCompilerOutput, commandLine } from "../../src/client/compiler";
import { toWslPath } from "../../src/client/wsl";

describe("compiler glue", () => {
  it("parses file:line: error lines", () => {
    const r = parseCompilerOutput("x.alan:5: error: Unknown name y\nother\n", "x.alan");
    assert.deepEqual(r, [{ line: 4, message: "Unknown name y" }]);
  });
  it("ignores colour codes", () => {
    const r = parseCompilerOutput("x.alan:2: \u001b[1;31merror:\u001b[0m bad\n", "x.alan");
    assert.equal(r[0].message, "bad");
  });
  it("translates Windows paths for WSL", () => {
    assert.equal(toWslPath("C:\\Users\\Σάββας\\a b\\h.alan"), "/mnt/c/Users/Σάββας/a b/h.alan");
  });
  it("builds argument arrays without shell quoting", () => {
    const c = commandLine({ exe: "C:\\t\\alanc.exe", wsl: false }, "run", "C:\\a b\\h.alan", { optimize: true });
    assert.deepEqual(c, { cmd: "C:\\t\\alanc.exe", args: ["run", "C:\\a b\\h.alan", "-O"] });
  });
});
```

- [ ] **Step 2: Run to fail**, **Step 3: implement**:
- `extension.ts` `activate`: start the language client (`vscode-languageclient/node`, server module `dist/server.js`), register the five commands, register a task provider for type `alan`, and when the first `.alan` file opens and `findCompiler` returns undefined, show "Alan compiler not found. Install it now?" with buttons Install and Not now.
- `commands.ts`:
  - `alan.run`: if the document is untitled or has no file on disk, run `workbench.action.files.saveAs` and stop if the user cancels. Otherwise save it, then run the compiler through a `vscode.Task` with a `ProcessExecution(cmd, args)` in a dedicated "Alan" terminal, so the program can read input. After the task ends with a non-zero exit, run `check` to fill the Problems panel.
  - `alan.build`: same save rule, `build` with `-o` next to the source, show "Built <path>" with a Reveal button.
  - `alan.showIr`: same save rule, run `alanc <file> [-O]`, open the output in an untitled `llvm` document beside the editor.
- `compilerCheck.ts`: on save (when `alan.checkOnSave`), the client runs `check` with `child_process.execFile` (argument array, 20 s timeout), parses the output, and sends `alan/compilerDiagnostics`.
- **Step 4: run to pass**, then manually: open `Examples/HelloWorld.alan` in the Extension Development Host (F5 in `vscode/`), press the play button, see "Hello world!" in the Alan terminal. Try a copy in a folder with a space and a Greek name. Try Run on an untitled document and cancel the save dialog: nothing runs.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/client vscode/src/server/compilerCheck.ts vscode/test/unit/compiler.test.ts
git commit -m "Add run, build and IR commands with compiler diagnostics and WSL mode"
```

---

### Task 14: Install command

**Files:**
- Create: `vscode/src/client/installer.ts`, `vscode/test/unit/installer.test.ts`, `vscode/test/fixtures/fake-release/`

**Interfaces:**
- Produces:

```ts
export interface ReleaseSource { apiLatest: string; download: (tag: string, asset: string) => string; }
export const GITHUB: ReleaseSource;
export function platformId(platform: NodeJS.Platform, arch: string): string;      // "win32","arm64" -> "windows-arm64"; throws "No Alan release for this platform." otherwise
export function assetName(tag: string, platform: NodeJS.Platform, arch: string): string;  // alan-v2.0.0-windows-x64.zip, alan-v2.0.0-macos-arm64.tar.gz
export async function install(storageDir: string, src: ReleaseSource, platform: NodeJS.Platform, arch: string,
                              progress?: (msg: string, pct: number) => void): Promise<{ tag: string; alanc: string }>;
export function installedCompilerPath(storageDir: string, platform: NodeJS.Platform): string | undefined;
export async function uninstall(storageDir: string): Promise<void>;
export const MIN_COMPILER = "v2.0.0";
```

`install` downloads into `<storage>/download.tmp`, verifies SHA-256 against the matching `SHA256SUMS` line, extracts into `<storage>/alan.new` (zip with `extract-zip`, tar.gz with `tar`), then renames to `<storage>/alan`, replacing any old copy. On macOS it runs `xattr -dr com.apple.quarantine` on the new folder and makes sure `bin/alanc` and `zig/zig` are executable. On any error it deletes `download.tmp` and `alan.new` and rethrows an `Error` with a message a person can act on ("Could not reach GitHub. Check your connection and try again.", "The download did not match its checksum. Nothing was installed.", "No Alan release for this platform."). WSL mode instead runs `install/install.sh` inside WSL with `wsl.exe -- sh -c "curl -fsSL <raw url> | sh"`.

- [ ] **Step 1: Failing tests** with a local `http.createServer` serving `test/fixtures/fake-release/` (a tiny zip or tar.gz holding `alan/bin/alanc(.exe)` as a text file, a matching `SHA256SUMS`, and a `latest.json` with `tag_name`):

```ts
it("installs, finds and removes the compiler", async () => {
  const r = await install(tmp, fake, process.platform, process.arch);
  assert.ok(fs.existsSync(r.alanc));
  assert.equal(installedCompilerPath(tmp, process.platform), r.alanc);
  await uninstall(tmp);
  assert.equal(installedCompilerPath(tmp, process.platform), undefined);
});
it("leaves nothing behind on a checksum mismatch", async () => {
  await assert.rejects(install(tmp, fakeCorrupt, process.platform, process.arch), /checksum/);
  assert.deepEqual(fs.readdirSync(tmp), []);
});
it("fails clearly when offline", async () => {
  await assert.rejects(install(tmp, unreachable, process.platform, process.arch), /Could not reach/);
  assert.deepEqual(fs.readdirSync(tmp), []);
});
```

- [ ] **Step 2: Run to fail**, **Step 3: implement**, **Step 4: run to pass**. Wire `alan.install` and `alan.uninstall` in `commands.ts` with `vscode.window.withProgress` and make `findCompiler` use `installedCompilerPath`. On activation, if the installed tag is older than `MIN_COMPILER`, offer an update.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/client/installer.ts vscode/test/unit/installer.test.ts vscode/test/fixtures
git commit -m "Add one-click compiler install and removal"
```

---

### Task 15: Debug information in the compiler

**Files:**
- Create: `debuginfo.hpp`, `debuginfo.cpp`, `tests/debug/lldb_check.py`, `tests/debug/dbg.alan`
- Modify: `ast.cpp` (code generation calls into debuginfo at function entry, each statement and each variable), `cli.cpp` (`-g` flag for `build` and `run`), `CMakeLists.txt` and `Makefile` (new source)

**Interfaces:**
- Consumes: the code generator in `ast.cpp`, `compile_to_module` (Task 3), `build` (Task 4).
- Produces:

```cpp
// debuginfo.hpp
struct DebugInfo;                                   // opaque
DebugInfo *di_begin(llvm::Module &m, const char *filePath);   // nullptr when -g is off
void di_function(DebugInfo *d, llvm::Function *f, const char *name, unsigned line,
                 const std::vector<std::pair<std::string, llvm::Type *>> &params);
void di_variable(DebugInfo *d, llvm::AllocaInst *slot, const char *name, unsigned line,
                 bool isByte, bool isArray, unsigned arraySize /* 0 when unknown */);
void di_location(DebugInfo *d, llvm::IRBuilder<> &b, unsigned line);   // sets b's current debug location
void di_end_function(DebugInfo *d);
void di_finish(DebugInfo *d);
```

- `compile_to_module(path, opt, codegen, debug)` gains a `debug` flag. `alanc build -g` and `alanc run -g` set it and force `opt` off. The IR printed by `alanc file.alan` is unchanged when `-g` is absent.
- Every AST node already carries `lineno` (see `parser.y`, the last argument of each `ast_*` call). Use it for locations.

- [ ] **Step 1: Failing LLDB test**

`tests/debug/dbg.alan`:

```
main () : proc
  total : int;
  add (a : int, b : int) : int
  {
    return a + b;
  }
{
  total = add(40, 2);
  writeInteger(total);
}
```

`tests/debug/lldb_check.py` builds it with `alanc build -g tests/debug/dbg.alan -o <tmp>/dbg`, then runs:

```
lldb --batch -o "breakpoint set --file dbg.alan --line 5" -o run -o "frame variable a b" -o "bt" -o continue <tmp>/dbg
```

and asserts the output contains `dbg.alan:5`, `(int) a = 40`, `(int) b = 2` and a frame named `add`. `lldb` comes from the LLVM 23 install on the CI runner (on Linux `lldb-23` from apt.llvm.org or the release package, on macOS the Xcode `lldb`, on Windows the `lldb.exe` in the LLVM package). Locally run it in WSL with `apt-get install lldb-23` as root.

Run (WSL): `python3 tests/debug/lldb_check.py --alanc ./alanc --lldb lldb-23`
Expected: FAIL, `-g` is not accepted.

- [ ] **Step 2: Implement `debuginfo.cpp`**

Use `llvm::DIBuilder`:
- `di_begin`: `createFile(basename, dirname)`, `createCompileUnit(llvm::dwarf::DW_LANG_C, file, "alanc", /*isOptimized*/ false, "", 0)`, basic types `int` = `createBasicType("int", 32, dwarf::DW_ATE_signed)` and `byte` = `createBasicType("byte", 8, dwarf::DW_ATE_unsigned_char)`. Add module flags `"Debug Info Version"` = `DEBUG_METADATA_VERSION` and `"Dwarf Version"` = 4 (and `"CodeView"` = 0, so Windows objects carry DWARF that LLDB reads).
- `di_function`: `createFunction` with a `DISubroutineType` built from the parameter types, scope = the enclosing function's `DISubprogram` for nested functions (keep a stack), `DISPFlagDefinition`, then `f->setSubprogram(sp)`. Parameters get `createParameterVariable` and `insertDeclare` on their allocas.
- `di_variable`: `createAutoVariable` with `int`, `byte` or an array type (`createArrayType(size * elemBits, align, elemType, subrange(0, size))`, or a pointer to the element type for array parameters of unknown size), then `insertDeclare(slot, var, createExpression(), DILocation, block)`.
- `di_location`: `b.SetCurrentDebugLocation(DILocation::get(ctx, line, 0, currentScope))`.
- `di_finish`: `finalize()`.

In `ast.cpp`, call these where the generator creates each function, each alloca for a parameter or local, and before generating each statement node. Nested functions receive outer variables through extra parameters: give those hidden parameters no debug variable, so LLDB shows each outer variable in its own frame.

- [ ] **Step 3: Keep the debug map on macOS**

On macOS, Zig links from object files and LLDB reads DWARF from the objects through the debug map. `build` with `-g` on macOS writes the object next to the output (`<out>.o`) instead of a temporary file and keeps it. `run -g` keeps both in the temporary folder until the program exits. Other platforms embed DWARF in the executable.

- [ ] **Step 4: Run to pass on all platforms**

Run (WSL): `make && python3 tests/debug/lldb_check.py --alanc ./alanc --lldb lldb-23`
Expected: PASS. Add the same step to the `compiler` matrix job in `ci.yml` and iterate until it passes on all six platforms. Also confirm `python3 tests/run_examples.py` still passes (debug info must not change behaviour).

- [ ] **Step 5: Commit**

```bash
git add debuginfo.cpp debuginfo.hpp ast.cpp cli.cpp CMakeLists.txt Makefile tests/debug .github/workflows/ci.yml
git commit -m "Emit DWARF debug information with -g"
```

---

### Task 16: Debugging in VS Code

**Files:**
- Create: `vscode/src/client/debug.ts`, `vscode/test/unit/debug.test.ts`
- Modify: `vscode/package.json` (debuggers, breakpoints, extensionDependencies), `vscode/src/client/extension.ts`

**Interfaces:**
- Consumes: `findCompiler`, `commandLine` (Task 13), compiler `build -g` (Task 15).
- Produces:

```ts
export function lldbLaunchConfig(exe: string, cwd: string, sourceFile: string): vscode.DebugConfiguration;
// { type: "lldb", request: "launch", name: "Alan: <file>", program: exe, cwd, terminal: "integrated",
//   sourceLanguages: ["c"], stopOnEntry: false }
export class AlanDebugConfigurationProvider implements vscode.DebugConfigurationProvider { ... }
```

`package.json` additions:

```json
"extensionDependencies": ["vadimcn.vscode-lldb"],
"contributes": {
  "breakpoints": [{"language": "alan"}],
  "debuggers": [{
    "type": "alan", "label": "Alan",
    "languages": ["alan"],
    "configurationAttributes": {"launch": {"required": ["program"], "properties": {
      "program": {"type": "string", "description": "The .alan file to debug.", "default": "${file}"}}}},
    "initialConfigurations": [{"type": "alan", "request": "launch", "name": "Debug Alan file", "program": "${file}"}]
  }]
}
```

Flow of `resolveDebugConfigurationWithSubstitutedVariables`: when `config.type` is empty and the active editor is Alan, fill in `program = active file`. Save the file. Build with `alanc build -g <file> -o <tmpdir>/<name>[.exe]` using `execFile` and show compile errors in the Problems panel (return `undefined` to cancel the session when the build fails). Then return `lldbLaunchConfig(exe, dirname(file), file)`, which VS Code hands to CodeLLDB. In WSL mode, show "Debugging needs the native compiler. Turn off alan.useWsl or use a Remote WSL window." and cancel.

- [ ] **Step 1: Failing test**

```ts
import { strict as assert } from "assert";
import { lldbLaunchConfig } from "../../src/client/debug";

it("builds a CodeLLDB launch configuration", () => {
  const c = lldbLaunchConfig("/tmp/x/h", "/src", "/src/h.alan");
  assert.equal(c.type, "lldb");
  assert.equal(c.request, "launch");
  assert.equal(c.program, "/tmp/x/h");
  assert.equal(c.terminal, "integrated");
});
```

- [ ] **Step 2: Run to fail**, **Step 3: implement** `debug.ts` and register the provider in `activate` (`vscode.debug.registerDebugConfigurationProvider("alan", provider)` plus a dynamic provider so F5 works without `launch.json`), **Step 4: run to pass**, then manually in the Extension Development Host: open `tests/debug/dbg.alan`, set a breakpoint on line 5, press F5. Expected: execution stops on line 5, the Variables view shows `a = 40` and `b = 2`, the Call Stack shows `add` above `main`, Step Over and Continue work, and the program prints 42 in the terminal.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/client/debug.ts vscode/test/unit/debug.test.ts vscode/package.json vscode/src/client/extension.ts
git commit -m "Add F5 debugging through CodeLLDB"
```

---

### Task 17: Formatter

**Files:**
- Create: `vscode/src/server/format.ts`, `vscode/test/unit/format.test.ts`
- Modify: `vscode/src/server/lexer.ts` (keep comments as trivia), `vscode/src/server/server.ts` (register formatting)

**Interfaces:**
- Consumes: `lex` (Task 9), `parse` (Task 10).
- Lexer change: `lex(src, { keepComments: true })` also returns `comments: { text: string; range: Range; block: boolean }[]`. Default behaviour is unchanged.
- Produces:

```ts
export interface FormatOptions { tabSize: number; insertSpaces: boolean; }
export function formatDocument(src: string, opts: FormatOptions): string | undefined;   // undefined when src has syntax errors
export function formatRange(src: string, range: Range, opts: FormatOptions): { range: Range; newText: string } | undefined;
```

Rules:
- Indent unit = `tabSize` spaces or one tab. Depth 0 for the top function header. A function's local declarations and nested function headers are one level deeper than its header. Its body `{` is at the header's level, and statements inside a block are one level deeper than the `{`.
- `if`, `else`, `while` with a non-block body put the body on the next line, one level deeper. `else if` stays on one line.
- One statement per line. One space around `= == != < > <= >= + - * / % & |` (binary), none after unary `+ - !`, one space after `,` and around `:` in declarations (`x : int`), none before `(` in calls and in `if (`/`while (` exactly one space.
- Line comments stay at the end of their line or on their own line with the current indent. Block comments are copied verbatim, their first line re-indented.
- Blank lines: runs of blank lines collapse to one. No blank line right after `{` or before `}`.
- Output ends with exactly one newline and uses the line ending of the input (CRLF when the input's first line ends with CRLF).

- [ ] **Step 1: Failing tests**

```ts
import { strict as assert } from "assert";
import * as fs from "fs"; import * as path from "path";
import { formatDocument } from "../../src/server/format";
import { lex } from "../../src/server/lexer";

const opts = { tabSize: 4, insertSpaces: true };
const ex = path.resolve(__dirname, "../../../Examples");

describe("formatter", () => {
  it("formats a messy program", () => {
    const src = "main():proc\nx:int;\n{x=1+2*3;if(x>3)writeInteger(x);else{x=0;}}\n";
    assert.equal(formatDocument(src, opts), [
      "main () : proc",
      "    x : int;",
      "{",
      "    x = 1 + 2 * 3;",
      "    if (x > 3)",
      "        writeInteger(x);",
      "    else {",
      "        x = 0;",
      "    }",
      "}", ""].join("\n"));
  });
  it("refuses to format code with syntax errors", () => {
    assert.equal(formatDocument("main () : proc\n{ x = ; }", opts), undefined);
  });
  for (const f of fs.readdirSync(ex).filter(f => f.endsWith(".alan"))) {
    it(`is stable and keeps comments for ${f}`, () => {
      const src = fs.readFileSync(path.join(ex, f), "utf8");
      const once = formatDocument(src, opts)!;
      assert.equal(formatDocument(once, opts), once);
      const before = lex(src, { keepComments: true }).comments!.map(c => c.text.trim());
      const after = lex(once, { keepComments: true }).comments!.map(c => c.text.trim());
      assert.deepEqual(after, before);
    });
  }
});
```

Decide the exact style for `else` after a block (`} else {` or `}` newline `else {`) by reading the examples and matching the most common style there. Update the first test's expected text to that choice before implementing.

- [ ] **Step 2: Run to fail**, **Step 3: implement** `format.ts` as a printer over the parsed tree that pulls comments in by position (each comment attaches to the next token, or to the end of the previous token's line when it is on the same line), **Step 4: run to pass**.

- [ ] **Step 5: Behaviour check.** Write every formatted example into a temporary copy of `Examples/` and run the harness against it: `python3 tests/run_examples.py --alanc ./alanc` with `ALAN_EXAMPLES_DIR` pointing at the copy (add that optional environment variable to `run_examples.py`, defaulting to the repo folder). Expected: all PASS, so formatting never changes behaviour.

- [ ] **Step 6: Register** `onDocumentFormatting` and `onDocumentRangeFormatting` in `server.ts` (they return `[]` when `formatDocument` returns undefined). Format on save works through the standard `editor.formatOnSave` setting, and the extension sets `"[alan]": {"editor.defaultFormatter": "sleousis.alan"}` in `configurationDefaults`.

- [ ] **Step 7: Commit**

```bash
git add vscode/src/server/format.ts vscode/src/server/lexer.ts vscode/src/server/server.ts vscode/test/unit/format.test.ts vscode/package.json tests/run_examples.py
git commit -m "Add Alan formatter"
```

---

### Task 18: Rename, references and highlights

**Files:**
- Create: `vscode/src/server/rename.ts`, `vscode/test/unit/rename.test.ts`
- Modify: `vscode/src/server/server.ts`

**Interfaces:**
- Consumes: `analyze`, `Analysis.references`, `Sym` (Task 11).
- Produces:

```ts
export function symbolAt(src: string, pos: Pos): { sym: Sym; range: Range } | undefined;
export function references(src: string, pos: Pos, includeDeclaration: boolean): Range[];
export function prepareRename(src: string, pos: Pos): { range: Range; placeholder: string } | { error: string };
export function rename(src: string, pos: Pos, newName: string): { edits: { range: Range; newText: string }[] } | { error: string };
```

Rules: references are every use that resolves to the same `Sym` (object identity), plus the declaration when requested. `prepareRename` refuses library functions ("Library functions cannot be renamed.") and positions not on a name. `rename` refuses a new name that is not an identifier (`/^[A-Za-z][A-Za-z0-9_]*$/`) or is a keyword ("'while' is a keyword."). It also refuses a name that is already declared in the declaring scope, or that would be captured by an inner declaration at any use site ("'x' would clash with the declaration at line N."). It refuses when the document has syntax errors.

- [ ] **Step 1: Failing tests**

```ts
import { strict as assert } from "assert";
import { references, prepareRename, rename } from "../../src/server/rename";

const src = [
  "m () : proc",
  " x : int;",
  " f () : proc",
  "  x : int;",
  " { x = 1; }",
  "{",
  " x = 2;",
  " f();",
  "}"].join("\n");

describe("rename", () => {
  it("finds references without crossing shadowing", () => {
    const r = references(src, { line: 6, character: 1 }, true);
    assert.deepEqual(r.map(x => x.start.line).sort(), [1, 6]);
  });
  it("renames the outer x only", () => {
    const r = rename(src, { line: 6, character: 1 }, "total") as any;
    assert.deepEqual(r.edits.map((e: any) => e.range.start.line).sort(), [1, 6]);
  });
  it("refuses keywords, library names and clashes", () => {
    assert.match((rename(src, { line: 6, character: 1 }, "while") as any).error, /keyword/);
    assert.match((prepareRename("m () : proc\n{ writeInteger(1); }", { line: 1, character: 3 }) as any).error, /Library/);
    assert.match((rename(src, { line: 6, character: 1 }, "f") as any).error, /clash/);
  });
});
```

- [ ] **Step 2: Run to fail**, **Step 3: implement**, **Step 4: run to pass**, **Step 5: register** `onReferences`, `onDocumentHighlight`, `onPrepareRename`, `onRenameRequest` in `server.ts`.

- [ ] **Step 6: Commit**

```bash
git add vscode/src/server/rename.ts vscode/src/server/server.ts vscode/test/unit/rename.test.ts
git commit -m "Add rename, find references and highlights"
```

---

### Task 19: End-to-end tests, docs and extension release

**Files:**
- Create: `vscode/test/e2e/extension.test.ts`, `vscode/test/e2e/index.ts`, `vscode/README.md`, `vscode/CHANGELOG.md`, `.github/workflows/vscode-release.yml`
- Modify: `.github/workflows/ci.yml` (vscode job), `README.md` (Editor support section)

- [ ] **Step 1: E2E test** with `@vscode/test-electron`: open `Examples/BubbleSort.alan`, wait for the extension, request `vscode.executeCompletionItemProvider` at a position inside the main block and assert `writeInteger` is offered, request `vscode.executeHoverProvider` on a function call and assert the signature text, insert `x = ;` and assert a diagnostic appears within 2 seconds, run `vscode.executeFormatDocumentProvider` on a messy copy and assert the result matches the formatter's unit test, and run `vscode.executeDocumentRenameProvider` on a local variable and assert the edit count. Run: `npm run test:e2e` (uses `xvfb-run` on Linux CI).

- [ ] **Step 2: ci.yml vscode job** on ubuntu-latest, windows-latest and macos-latest: `npm ci`, `npm run build`, `npm test`, `npm run test:grammar`, `npm run test:e2e`, `npx vsce package` and upload the `.vsix` as an artifact.

- [ ] **Step 3: vscode-release.yml** on `vscode-v*` tags: build and test, `npx vsce package`, create a GitHub release with the `.vsix`, then:

```yaml
- name: Publish to VS Code Marketplace
  if: ${{ env.VSCE_PAT != '' }}
  run: npx vsce publish --packagePath *.vsix
  env: { VSCE_PAT: "${{ secrets.VSCE_PAT }}" }
- name: Publish to Open VSX
  if: ${{ env.OVSX_PAT != '' }}
  run: npx ovsx publish *.vsix -p "$OVSX_PAT"
  env: { OVSX_PAT: "${{ secrets.OVSX_PAT }}" }
- name: Warn about missing tokens
  if: ${{ env.VSCE_PAT == '' || env.OVSX_PAT == '' }}
  run: echo "::warning::Marketplace or Open VSX token missing, publishing skipped."
  env: { VSCE_PAT: "${{ secrets.VSCE_PAT }}", OVSX_PAT: "${{ secrets.OVSX_PAT }}" }
```

- [ ] **Step 4: Docs.** `vscode/README.md` (Marketplace page): what it does, a screenshot of highlighting plus a diagnostic plus the completion list (capture with the Extension Development Host), a short GIF of pressing Run, settings table, commands table, "Install the compiler" section. Root `README.md` gets an "Editor support" section linking the Marketplace listing and the Releases page.

- [ ] **Step 5: License and publisher (user).** Ask the user which license to add to the repository (needed for Marketplace publishing). Add `LICENSE`, set `license` in `package.json`, remove `private`. Give the user the exact steps: create publisher `sleousis` at https://marketplace.visualstudio.com/manage, create an Azure DevOps personal access token with the Marketplace (Manage) scope, `gh secret set VSCE_PAT -R sleousis/alan-compiler`, create an Open VSX token at https://open-vsx.org/user-settings/tokens and `gh secret set OVSX_PAT`, and claim the namespace with `npx ovsx create-namespace sleousis -p <token>`.

- [ ] **Step 6: Release.** Tag `v2.0.0` (compiler), wait for the release, run both installers from the real release on a clean folder, then tag `vscode-v1.0.0`. Install the published extension in a clean VS Code profile (`code --profile alan-test --install-extension sleousis.alan`), open an example, install the compiler from the prompt, press Run. Expected: program output in the Alan terminal, on Windows natively and with `alan.useWsl` on. Then set a breakpoint and press F5: execution stops there and variables show. Ask the user to repeat the Run and F5 check on any Mac or ARM64 machine they have, since those are only covered by CI.

- [ ] **Step 7: Commit**

```bash
git add vscode .github/workflows README.md LICENSE
git commit -m "Add end-to-end tests, docs and extension release workflow"
```
