# Alan editor support, native Windows and one-click install

Date: 2026-09-26
Status: approved in conversation, waiting for spec review

## Goal

Make Alan as easy to write and run as a mainstream language. A user installs the "Alan" extension in VS Code, opens an `.alan` file and gets colours, live errors and autocompletion. One click installs the compiler, and one click runs the program in a terminal. The same compiler works natively on Windows and Linux, and on Windows it can also run inside WSL. People without VS Code can install the compiler with a one-line script.

Success criteria:

- Every program in `Examples/` gives the same output through the new pipeline as it does today with LLVM 23 and the assembly runtime, on Linux and on native Windows.
- A fresh Windows or Linux machine with only VS Code goes from "install extension" to "program output in the terminal" without installing anything by hand.
- Syntax errors show while typing, with exact ranges, several at once, even when no compiler is installed.

## Decisions taken

| Topic | Decision |
| --- | --- |
| Platforms | Native Windows x64 and Linux x64. WSL on Windows is an optional mode. |
| Runtime | One C runtime for both platforms. The assembly `alan_lib_v2` stays in the repo for reference and is no longer built. |
| Editor intelligence | The extension has its own Alan parser in TypeScript. The compiler adds type errors on save. |
| Toolchain | Self-contained bundle: `alanc` linked statically with LLVM 23, prebuilt runtime, pinned Zig used only as linker and C library. |
| Distribution | VS Code Marketplace, Open VSX, and a `.vsix` on GitHub Releases. |
| Location | Everything lives in the alan-compiler repo. The extension goes in `vscode/`. |

## 1. Components

1. **Compiler `alanc`.** Same compiler with three additions. It is linked statically with LLVM 23. It can write object files directly. It gets two commands, `alanc build file.alan [-o name] [-O]` and `alanc run file.alan [-O]`. The existing `alanc file.alan [-O]` behaviour (IR on standard output) is unchanged, so the `alan` script keeps working.
2. **Runtime `runtime/`.** New C sources for the 14 Alan library functions: `writeInteger`, `writeByte`, `writeChar`, `writeString`, `readInteger`, `readByte`, `readChar`, `readString`, `extend`, `shrink`, `strlen`, `strcmp`, `strcpy`, `strcat`. Compiled with `zig cc` into `libalanrt.a` per target.
3. **Toolchain bundle.** Release assets `alan-<version>-windows-x64.zip` and `alan-<version>-linux-x64.tar.gz` holding `alanc`, `libalanrt.a`, a pinned Zig toolchain and a README. `alanc` finds Zig and the runtime relative to its own executable.
4. **VS Code extension `vscode/`.** TextMate grammar, a TypeScript language server with its own parser, commands to install the compiler, run, build and show IR, and settings.

Run flow: the extension saves the file, calls `alanc run file.alan` in an "Alan" terminal, `alanc` parses, checks, emits an object file, links it with `libalanrt.a` through the bundled `zig cc`, and runs the program in the same terminal so input and output work.

## 2. Compiler and runtime changes

- **Builds.** Linux: official LLVM 23 static libraries, built inside an `ubuntu:20.04` container so `alanc` needs only glibc 2.31 or newer. Windows: MSVC against the official LLVM 23 Windows package, with win_flex_bison. LLVM is linked statically on both.
- **Object output.** `alanc build` creates a `TargetMachine` for the target triple and writes an object file. Targets: `x86_64-windows-gnu` on Windows, `x86_64-linux-musl` on Linux. Linking runs `zig cc -target <triple> <obj> <runtime>/libalanrt.a -o <out>`. Linux executables are static and run on any distribution.
- **Symbol names.** The runtime exports `alan_`-prefixed symbols (for example `alan_strlen`) so they do not clash with the C library. Only the LLVM function names in the `funLibrary` declarations in `ast.cpp` change. The Alan-visible names in the symbol table stay the same, so Alan source code does not change.
- **Types and behaviour.** The C functions use exactly the LLVM types the compiler declares today (for example `writeInteger(i32)`). Behaviour copies the assembly runtime: integer and byte widths, `readString` size limit and newline handling, output formatting. Differences found by the example tests are fixed in the C runtime, never in the expected files.
- **Error format.** Syntax errors change from "Alan error: ... Aborting, I've had enough with line N" to `file:line: error: message`, the format semantic errors already use in `error.cpp`. ANSI colours are printed only when standard error is a terminal.
- **Check mode.** `alanc check file.alan` parses and type-checks without code generation and exits with status 0 or 1. The extension uses it on save.
- **Compatibility.** `alan`, `do.sh` and `alan_lib_v2/` stay as they are and keep working on Linux with a system LLVM 23.

## 3. Installer

- **From VS Code.** When an `.alan` file opens and no compiler is found, a notification offers "Install Alan compiler". The command "Alan: Install or Update Compiler" does the same. It reads the latest `v*` release from the GitHub API, downloads the bundle for the platform, checks it against `SHA256SUMS`, and extracts it into the extension's global storage. No admin rights. A progress notification shows the download.
- **Without VS Code.** `install/install.ps1` (Windows) installs to `%LOCALAPPDATA%\alan` and adds it to the user PATH. `install/install.sh` (Linux) installs to `~/.local/share/alan` and links `alanc` into `~/.local/bin`. Usage is documented as `irm <raw url>/install.ps1 | iex` and `curl -fsSL <raw url>/install.sh | sh`. Both print how to uninstall.
- **Compiler lookup order.** `alan.compilerPath` setting, then the extension's installed copy, then `alanc` on PATH.
- **WSL mode.** Setting `alan.useWsl` (default off, Windows only). When on, install puts the Linux bundle in the default WSL distro under `~/.local/share/alan`, and run and check call `wsl alanc ...` with the path translated by `wslpath`.
- **Versions.** Compiler releases use `v*` tags. The next one is `v2.0.0` because the runtime and command line change. The extension uses `vscode-v*` tags and declares a minimum compiler version. It offers an update when the installed compiler is older.
- **Uninstall.** "Alan: Remove Installed Compiler" deletes the installed folder.

## 4. VS Code extension

- **Grammar.** Keywords `if else while return proc reference int byte true false`, line comments `--`, nested block comments `(* *)`, string and character literals with escapes (`\n`, `\t`, `\r`, `\0`, `\\`, `\'`, `\"`, `\xNN`), numbers, operators, function declarations, library calls. Language configuration adds bracket matching, auto-closing pairs and comment toggling.
- **Language server.** Runs in the extension host with `vscode-languageserver`.
  - Lexer and recursive-descent parser for the full grammar in `parser.y`, with error recovery at `;`, `}` and declaration boundaries. It produces a syntax tree with ranges and a tree of nested scopes.
  - Live diagnostics: syntax errors, undeclared names, duplicate names in one scope, wrong argument count in calls.
  - Compiler diagnostics on save through `alanc check` when a compiler is available. Its `file:line: error: message` lines become diagnostics on that line. Errors that duplicate a live diagnostic are dropped.
  - Completion: keywords, the 14 library functions with signature and description, functions, parameters and variables visible at the cursor, and snippets for a function skeleton, `if`, `if-else` and `while`.
  - Hover and signature help showing declarations such as `x : int[]` and `swap (a : reference int, b : reference int) : proc`.
  - Go to definition and document symbols (outline, including nested functions).
- **Commands.** "Alan: Run" (editor title play button and a task for F5), "Alan: Build", "Alan: Show IR" (side editor), "Alan: Install or Update Compiler", "Alan: Remove Installed Compiler". Run and Build save the file first and send compile errors to the Problems panel.
- **Settings.** `alan.compilerPath`, `alan.optimize` (default true, passes `-O`), `alan.useWsl`, `alan.checkOnSave` (default true).

## 5. Testing, CI and publishing

- **Compiler and runtime tests (`tests/`).** Each example runs through `alanc run` with a fixed input file. Output is compared with expected files recorded from the current verified build (LLVM 23 with the assembly runtime). Error tests check `file:line: error` messages for broken programs, including `Examples/test2`. Run on Linux and Windows in CI.
- **Parser tests.** Every file in `Examples/` except the intentional error file parses with no diagnostics. A set of broken snippets produces the expected messages and ranges.
- **Extension tests.** `@vscode/test-electron` opens examples and checks completion items, hover text and diagnostics. The install command is tested against a local fake release server.
- **Installer tests.** CI runs `install.sh` on Ubuntu and `install.ps1` on Windows against the built bundle, then `alanc run Examples/HelloWorld.alan`.
- **Workflows.** `ci.yml` on every push and pull request builds and tests everything. `release.yml` (replacing the current one) runs on `v*` tags, builds both bundles, writes `SHA256SUMS`, tests the packaged bundles and publishes the release. `vscode-release.yml` runs on `vscode-v*` tags, packages the `.vsix`, attaches it to a release, and publishes to the Marketplace (`VSCE_PAT`, publisher `sleousis`) and Open VSX (`OVSX_PAT`). Publishing steps are skipped with a warning when a token is missing.
- **User setup, once.** Create the Marketplace publisher `sleousis` and add an Azure DevOps token as repo secret `VSCE_PAT`. Create an Open VSX token as `OVSX_PAT`.
- **Docs.** Root README gets "Install" and "Editor support" sections. `vscode/README.md` is the Marketplace page with a screenshot and an animated demo.

## Out of scope

- Other architectures (ARM64) and macOS.
- A debugger.
- Rewriting the compiler or changing the Alan language.
- Formatting and rename refactoring.
