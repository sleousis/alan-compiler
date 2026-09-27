# Alan compiler

A compiler for Alan, a small Pascal/C-like teaching language. It was written as a university compilers course project (most likely the NTUA Compilers course, which used Alan in 2018). `alanc` reads an `.alan` source file, checks it and turns it into machine code with LLVM 23, which is built into it. It links the program with the Alan runtime library through a bundled Zig toolchain. It runs natively on Windows, Linux and macOS, each on x64 and ARM64.

## Contents

- Lexer (flex) and parser (bison) for the Alan language.
- Semantic checks with a symbol table and `file:line: error: message` errors.
- LLVM code generation with optional optimization (`-O`) and debug information (`-g`).
- The `alanc` commands `check`, `build` and `run`.
- The Alan runtime library in C (`runtime/`).
- One-line installers (`install/`) and a Visual Studio Code extension (`vscode/`).
- Example Alan programs in `Examples/` and tests in `tests/`.
- The language specification (`alan2018.pdf`).

## Install

One command installs the latest release. It needs nothing else, because the bundle carries the Zig toolchain that links programs.

```
Windows (PowerShell):  irm https://raw.githubusercontent.com/sleousis/alan-compiler/master/install/install.ps1 | iex
Linux and macOS:       curl -fsSL https://raw.githubusercontent.com/sleousis/alan-compiler/master/install/install.sh | sh
```

On Windows the compiler goes to `%LOCALAPPDATA%\alan` and its `bin` folder is added to your user PATH. On Linux and macOS it goes to `~/.local/share/alan` and `alanc` is linked into `~/.local/bin`. The installers check the download against the release's `SHA256SUMS` and print how to uninstall. To install a given release instead of the latest, set `ALAN_VERSION`:

```
Windows (PowerShell):  $env:ALAN_VERSION = "v2.0.0"; irm https://raw.githubusercontent.com/sleousis/alan-compiler/master/install/install.ps1 | iex
Linux and macOS:       curl -fsSL https://raw.githubusercontent.com/sleousis/alan-compiler/master/install/install.sh | ALAN_VERSION=v2.0.0 sh
```

Then run a program:

```
alanc run hello.alan                 compile, link and run the program
alanc build hello.alan -o hello      compile and link an executable
alanc check hello.alan               check the program for errors only
```

Add `-O` to `run` or `build` to turn on optimization. The first program takes a minute or two longer, because Zig prepares its C library once.

## Editor support

The Alan extension for Visual Studio Code adds highlighting, live errors, completion, formatting, rename, one-click Run and debugging with breakpoints. It installs the compiler for you on first use. Download the `.vsix` from the [Releases page](https://github.com/sleousis/alan-compiler/releases) (tags starting with `vscode-v`) and install it with **Extensions: Install from VSIX...**. Once the extension is published, it is also on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=sleousis.alan) and [Open VSX](https://open-vsx.org/extension/sleousis/alan). The extension lives in [`vscode/`](vscode) and its [README](vscode/README.md) lists its commands and settings.

## Download

The [Releases page](https://github.com/sleousis/alan-compiler/releases) has a self-contained bundle for each system, if you prefer to install by hand:

| File | System |
| --- | --- |
| `alan-<version>-windows-x64.zip` | Windows on x64 |
| `alan-<version>-windows-arm64.zip` | Windows on ARM64 |
| `alan-<version>-linux-x64.tar.gz` | Linux on x64 |
| `alan-<version>-linux-arm64.tar.gz` | Linux on ARM64 |
| `alan-<version>-macos-x64.tar.gz` | macOS 12 or later on Intel |
| `alan-<version>-macos-arm64.tar.gz` | macOS 12 or later on Apple silicon |

Each one unpacks to an `alan` folder with `bin/alanc`, the runtime library in `lib`, the Zig toolchain in `zig`, a `README.txt` and a `VERSION` file. Nothing else has to be installed. LLVM and clang are not needed, because `alanc` has LLVM built in and Zig links the programs. Check the download against `SHA256SUMS` from the same release, then run `alan/bin/alanc run hello.alan` or add `alan/bin` to your PATH. The Linux bundles were built on Ubuntu 20.04 and run there and on newer distributions.

Release v1.0.0 is older. It has only a Linux x86-64 build that needs LLVM 23 and clang 23 from [apt.llvm.org](https://apt.llvm.org), and the installers above do not handle it.

## Tech stack

These are the versions the compiler is built and tested with (September 2026). `tools/versions.env` pins them for the build scripts and CI.

| Tool | Version |
| --- | --- |
| LLVM (C++ API, linked statically into `alanc`) | 23.1.2 |
| C++ standard | C++17 (required by LLVM 23) |
| Zig (links programs and builds the runtime) | 0.16.0 |
| GNU Bison | 3.8.2 (win_flex_bison on Windows) |
| flex | 2.6.4 |
| CMake | 3.28 or newer |

The project was first written for an older LLVM with typed pointers (it built with LLVM 10). The code generator now uses opaque pointers and the new pass manager, as current LLVM requires.

## Repository layout

| Path | What it is |
| --- | --- |
| `lexer.l` | flex lexer |
| `parser.y` | bison grammar, builds the AST |
| `ast.cpp`, `ast.hpp` | AST, semantic checks and LLVM code generation |
| `debuginfo.cpp`, `debuginfo.hpp` | DWARF debug information for `-g` |
| `cli.cpp`, `emit.cpp` | the `alanc` commands, object output and linking |
| `symbol.cpp`, `symbol.hpp` | symbol table |
| `error.cpp`, `general.cpp` | error reporting and helpers |
| `CMakeLists.txt` | builds `alanc` on every platform |
| `runtime/` | the Alan runtime library in C, built into `libalanrt.a` with Zig |
| `tools/` | build scripts per platform and the bundle packager |
| `install/` | the one-line installers |
| `tests/` | example and error tests (see its `README.md`) |
| `vscode/` | the Visual Studio Code extension |
| `Examples/` | sample programs (`test` and `test2` are Alan sources without the `.alan` extension) |
| `alan2018.pdf` | Alan language specification |
| `Makefile`, `alan`, `do.sh`, `alan_lib_v2/` | the older Linux-only pipeline (see below) |

## Build from source

Each script builds `alanc` and `libalanrt.a` for the machine it runs on into `dist/<platform>/`, as `bin/alanc` and `lib/libalanrt.a`. All of them need CMake, Python 3 and Zig 0.16.0 (set `ALAN_ZIG` to the `zig` executable, or put it on the PATH).

- **Linux (x64 or ARM64):** `sh tools/build-linux.sh`. It needs GCC 11 or newer, flex and Bison 3.8. LLVM comes from `LLVM_DIR`, from `/usr/lib/llvm-23` (the `llvm-23-dev` package from [apt.llvm.org](https://apt.llvm.org)), or else from the official LLVM release package, which the script downloads. Release builds run inside Ubuntu 20.04, so `alanc` needs only glibc 2.31 or newer.
- **Windows (x64 or ARM64):** `powershell -File tools\build-windows.ps1` on a machine with Visual Studio and its C++ tools. The script downloads the official LLVM release package and win_flex_bison, and builds zlib and zstd.
- **macOS (Intel or Apple silicon):** `sh tools/build-macos.sh`. It first builds LLVM 23 from source for macOS 12, which takes about an hour once. Bison, flex and ninja come from Homebrew as build tools only, and `alanc` links only system libraries.

`alanc` looks for Zig in `../zig` and for the runtime in `../lib`, next to its own folder. For a build in `dist/`, set `ALAN_ZIG` and `ALAN_RUNTIME` (the path of `libalanrt.a`). Or make a bundle with `python tools/package.py --platform <platform> --version dev --zig <zig folder>`, which writes `out/alan-dev-<platform>` as a `.zip` or `.tar.gz`.

Run the tests against a build:

```
python tests/run_examples.py --alanc dist/linux-x64/bin/alanc
python tests/run_errors.py --alanc dist/linux-x64/bin/alanc
```

## Usage

```
alanc run FILE.alan [-O] [-g]                 compile, link and run the program
alanc build FILE.alan [-o NAME] [-O] [-g]     compile and link an executable
alanc check FILE.alan                         check the program for errors only
alanc FILE.alan [-O]                          print the LLVM IR
```

| Option | Meaning |
| --- | --- |
| `-O` | enable optimizations |
| `-g` | add debug information for a debugger such as LLDB (turns optimization off) |
| `-o NAME` | set the name of the executable (`build` only) |

Errors are printed as `file:line: error: message`, and `check` exits with status 1 when it finds any. `run` passes the program's input and output through, so interactive programs work.

## Example

```
$ alanc run Examples/HelloWorld.alan
Hello world!

$ alanc build Examples/BubbleSort.alan -O -o bubble && ./bubble
Initial array: 35, 67, 8, 6, 36, 6, 38, 80, 78, 7, 78, 9, 51, 49, 79, 49
Sorted array: 6, 6, 7, 8, 9, 35, 36, 38, 49, 49, 51, 67, 78, 78, 79, 80
```

## The older Linux pipeline

Release v1.0.0 used a different pipeline. It still works on Linux x86-64 with LLVM 23 and clang 23 from [apt.llvm.org](https://apt.llvm.org). `make` builds `alanc` with g++ (the Makefile calls `llvm-config`, `bison` and `flex` without a version suffix). The `alan` script turns a `.alan` file into an executable in a folder named after it: `alanc` prints LLVM IR, `llc` turns it into x86-64 assembly and `clang` links it with the assembly runtime library in `alan_lib_v2/lib.a`. Run `./alan -h` for its options. `./do.sh FILE.alan` does the same three steps in the current folder. `alan_lib_v2/libs.sh` rebuilds `lib.a` with NASM.

That runtime lives in a NASM section called `.code`, which is not marked executable, and it uses absolute addresses. So the scripts link with `-no-pie -Wl,-z,noseparate-code`. Its input functions read standard input with raw system calls, so input from a pipe can lose lines. The C runtime in `runtime/` has none of these limits.

## Notes and known limitations

- `Examples/papariatest.alan` has statements after a `return`. The compiler skips them, so the program compiles and runs with and without `-O`.
- `Examples/test2` is a test file for semantic errors. The compiler rejects it with an error message.
- The expected outputs in `tests/expected/` were recorded with the older pipeline. CI compares the new compiler and runtime against them. The results were not checked against the original assignment answers.
- The first program on a machine takes a minute or two longer to link, because Zig builds its C library for the target once.
- The shell scripts must have Unix (LF) line endings. `.gitattributes` makes sure of this on Windows checkouts.

## Author

Savvas Leousis
