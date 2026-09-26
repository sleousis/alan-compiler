# Alan compiler

A compiler for Alan, a small Pascal/C-like teaching language. It was written as a university compilers course project (most likely the NTUA Compilers course, which used Alan in 2018). The compiler reads an `.alan` source file, checks it and emits LLVM IR. `llc` turns the IR into x86-64 assembly and `clang` links it with the Alan runtime library in `alan_lib_v2`.

## Contents

- Lexer (flex) and parser (bison) for the Alan language.
- Semantic checks with a symbol table and error messages with line numbers.
- LLVM IR code generation, with optional optimization passes (`-O`).
- The Alan runtime library (`alan_lib_v2`), written in x86-64 NASM assembly.
- Example Alan programs in `Examples/`.
- The language specification (`alan2018.pdf`).

## Tech stack

- C++ (g++)
- flex and bison
- LLVM 10 (C++ API, `llc`) and clang 10
- NASM (only to rebuild the runtime library)
- Bash

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

## Prerequisites

The compiler builds and runs on Linux x86-64. It was verified on Ubuntu 20.04 (also under WSL on Windows) with:

```
sudo apt-get install g++ make flex bison llvm-10-dev clang-10 nasm
```

`nasm` is only needed to rebuild `alan_lib_v2/lib.a`.

The code uses the LLVM C++ API with typed pointers and the legacy pass manager. It builds with LLVM 10. Newer LLVM versions (15 and later) removed APIs it uses and will not work without code changes.

The Makefile and the `alan` script call `llvm-config`, `llc` and `clang` without a version suffix. With the Ubuntu `llvm-10` packages, put the LLVM 10 tools first on the `PATH`:

```
export PATH=/usr/lib/llvm-10/bin:$PATH
```

## Build

```
make
```

This runs flex and bison and produces the `alanc` executable. `make clean` removes the generated files and `make distclean` also removes `alanc`.

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
clang a.s alan_lib_v2/lib.a -Wl,-z,noseparate-code -o a.out
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
- The runtime input functions read from standard input with raw system calls. When the input comes from a pipe or a file, one read can take several lines at once and the next read call misses them. Type the input interactively, or send it one line at a time.
- `Examples/papariatest.alan` has statements after a `return`. Without `-O` the generated IR is rejected by `llc`. With `-O` it compiles and runs.
- `Examples/test2` is a test file for semantic errors. The compiler rejects it with an error message.
- All example programs were compiled and run. Their results were not checked against the original assignment answers.
- The shell scripts must have Unix (LF) line endings. `.gitattributes` makes sure of this on Windows checkouts.

## Author

Savvas Leousis
