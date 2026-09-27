# Alan compiler

A compiler for Alan, a small Pascal/C-like teaching language. It was written as a university compilers course project (most likely the NTUA Compilers course, which used Alan in 2018). The compiler reads an `.alan` source file, checks it and emits LLVM IR. `llc` turns the IR into x86-64 assembly and `clang` links it with the Alan runtime library in `alan_lib_v2`.

## Contents

- Lexer (flex) and parser (bison) for the Alan language.
- Semantic checks with a symbol table and error messages with line numbers.
- LLVM IR code generation, with optional optimization passes (`-O`).
- The Alan runtime library (`alan_lib_v2`), written in x86-64 NASM assembly.
- Example Alan programs in `Examples/`.
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

The Alan extension for Visual Studio Code adds highlighting, live errors, completion, formatting, rename, one-click Run and debugging with breakpoints. It installs the compiler for you on first use. Get it from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=sleousis.alan) or [Open VSX](https://open-vsx.org/extension/sleousis/alan), or download the `.vsix` from the [Releases page](https://github.com/sleousis/alan-compiler/releases) (tags starting with `vscode-v`) and install it with **Extensions: Install from VSIX...**. The extension lives in [`vscode/`](vscode) and its [README](vscode/README.md) lists its commands and settings.

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

These are the versions the compiler was last built and tested with (September 2026):

| Tool | Version |
| --- | --- |
| LLVM (C++ API, `llc`) and clang | 23.1.2 |
| C++ standard | C++17 (required by LLVM 23) |
| C++ compiler | g++ 9.4 or clang++ 23.1.2 |
| GNU Bison | 3.8.2 |
| flex | 2.6.4 |
| NASM | 3.02 (only to rebuild the runtime library) |
| GNU Make, Bash | from Ubuntu 20.04 |

The project was first written for an older LLVM with typed pointers (it built with LLVM 10). The code generator now uses opaque pointers and the new pass manager, as current LLVM requires.

## Repository layout

| Path | What it is |
| --- | --- |
| `lexer.l` | flex lexer |
| `parser.y` | bison grammar, builds the AST |
| `ast.cpp`, `ast.hpp` | AST, semantic checks and LLVM code generation |
| `symbol.cpp`, `symbol.hpp` | symbol table |
| `error.cpp`, `general.cpp` | error reporting and helpers |
| `Makefile` | builds the `alanc` compiler |
| `alan` | driver script: `.alan` file to executable |
| `do.sh` | older, minimal driver script |
| `alan_lib_v2/` | runtime library sources and the prebuilt `lib.a` (see its `README.txt`) |
| `Examples/` | sample programs (`test` and `test2` are Alan sources without the `.alan` extension) |
| `alan2018.pdf` | Alan language specification |
| `vscode/` | the Visual Studio Code extension |

## Prerequisites

The compiler builds and runs on Linux x86-64. It was verified on Ubuntu 20.04 under WSL on Windows.

LLVM and clang 23 come from [apt.llvm.org](https://apt.llvm.org):

```
wget -qO- https://apt.llvm.org/llvm-snapshot.gpg.key | sudo tee /etc/apt/trusted.gpg.d/apt.llvm.org.asc
echo "deb http://apt.llvm.org/focal/ llvm-toolchain-focal-23 main" | sudo tee /etc/apt/sources.list.d/llvm-23.list
sudo apt-get update
sudo apt-get install g++ make flex llvm-23-dev clang-23 libzstd-dev zlib1g-dev libxml2-dev libedit-dev libcurl4-openssl-dev
```

Use the matching `llvm-toolchain-<codename>-23` line on other Ubuntu releases. Newer distributions may ship recent enough Bison and NASM packages. Ubuntu 20.04 does not, so Bison 3.8.2 and NASM 3.02 were built from the official source releases:

```
wget https://ftp.gnu.org/gnu/bison/bison-3.8.2.tar.xz
tar xf bison-3.8.2.tar.xz && cd bison-3.8.2
./configure --prefix=/mnt/d/tools/bison-3.8.2 && make && make install
cd ..
wget https://www.nasm.us/pub/nasm/releasebuilds/3.02/nasm-3.02.tar.xz
tar xf nasm-3.02.tar.xz && cd nasm-3.02
./configure --prefix=/mnt/d/tools/nasm-3.02 && make && make install
```

The Makefile and the `alan` script call `llvm-config`, `llc`, `clang`, `bison` and `nasm` without a version suffix. Put the tools first on the `PATH`:

```
export PATH=/usr/lib/llvm-23/bin:/mnt/d/tools/bison-3.8.2/bin:/mnt/d/tools/nasm-3.02/bin:$PATH
```

## Build

```
make
```

This runs flex and bison and produces the `alanc` executable. The Makefile uses g++. To build with clang++ 23 instead, run `make CXX=clang++`. `make clean` removes the generated files and `make distclean` also removes `alanc`.

On Windows, build and run inside WSL (for example Ubuntu 20.04) from the repository folder, such as `/mnt/d/Git/alan-compiler`. There is no native Windows build.

## Usage

```
./alan [OPTION]... FILE.alan
```

| Option | Meaning |
| --- | --- |
| `-ir`, `--intermediate` | keep the LLVM IR file (`.imm`) |
| `-s`, `--assembly` | keep the assembly file (`.asm`) |
| `-x`, `--execute` | run the executable after compiling |
| `-O`, `--optimization` | enable optimizations |
| `-o NAME`, `--name NAME` | set the name of the executable |
| `-h`, `--help` | show help |

The script creates a folder named after the source file (for `Examples/HelloWorld.alan` it is `HelloWorld/`) and puts the executable and any kept files there. Source files must have the `.alan` extension.

`alanc` can also be used on its own. It reads the source file and prints LLVM IR to standard output:

```
./alanc Examples/HelloWorld.alan > a.ll
llc a.ll -o a.s
clang a.s alan_lib_v2/lib.a -no-pie -Wl,-z,noseparate-code -o a.out
```

`./do.sh FILE.alan` does exactly these three steps.

### Rebuilding the runtime library

```
cd alan_lib_v2
./libs.sh
```

This assembles all `.asm` files with NASM and writes `lib.a`.

## Example

```
$ ./alan -x Examples/HelloWorld.alan
Compiling HelloWorld...
Compilation complete!
Executing HelloWorld...

------------------------------------------

Hello world!

$ ./alan -O Examples/BubbleSort.alan && ./BubbleSort/BubbleSort
Compiling BubbleSort...
Compilation complete!
Initial array: 35, 67, 8, 6, 36, 6, 38, 80, 78, 7, 78, 9, 51, 49, 79, 49
Sorted array: 6, 6, 7, 8, 9, 35, 36, 38, 49, 49, 51, 67, 78, 78, 79, 80
```

## Notes and known limitations

- The runtime library code lives in a NASM section called `.code`, which is not marked executable. Current linkers put such sections in a non-executable segment, so programs crashed at the first library call. The `alan` and `do.sh` scripts now link with `-Wl,-z,noseparate-code` to keep the old layout. Add this flag too if you link by hand.
- The runtime library uses absolute addresses, so it cannot be linked into a position independent executable. Current clang builds PIE by default, so the scripts also pass `-no-pie`.
- NASM 3.02 warns "implicit DEFAULT ABS is deprecated" for some runtime files. The warning is harmless. The rebuilt `lib.a` has exactly the same machine code as the committed one.
- The runtime input functions read from standard input with raw system calls. When the input comes from a pipe or a file, one read can take several lines at once and the next read call misses them. Type the input interactively, or send it one line at a time.
- `Examples/papariatest.alan` has statements after a `return`. The compiler skips them, so the program compiles and runs with and without `-O`.
- `Examples/test2` is a test file for semantic errors. The compiler rejects it with an error message.
- All example programs were compiled and run with LLVM 23, with and without `-O`. Given the same input, their output matched the LLVM 10 build exactly. The results were not checked against the original assignment answers.
- The shell scripts must have Unix (LF) line endings. `.gitattributes` makes sure of this on Windows checkouts.

## Author

Savvas Leousis
