# Alan editor support, native Windows and one-click install

Date: 2026-09-26
Status: implemented on the editor-support branch

## Goal

Make Alan as easy to write and run as a mainstream language. A user installs the "Alan" extension in VS Code, opens an `.alan` file and gets colours, live errors, autocompletion, formatting, rename and a debugger. One click installs the compiler, and one click runs the program in a terminal. The same compiler works natively on Windows, Linux and macOS, on x64 and ARM64, and on Windows it can also run inside WSL. People without VS Code can install the compiler with a one-line script.

Success criteria:

- Every program in `Examples/` gives the same output through the new pipeline as it does today with LLVM 23 and the assembly runtime, on all six platforms.
- A fresh Windows, Linux or macOS machine with only VS Code goes from "install extension" to "program output in the terminal" without installing anything by hand.
- Syntax errors show while typing, with exact ranges, several at once, even when no compiler is installed.
- F5 stops at a breakpoint in an `.alan` file and shows Alan variables with their values.

## Decisions taken

| Topic | Decision |
| --- | --- |
| Platforms | Native Windows, Linux and macOS, each on x64 and ARM64 (six bundles). WSL on Windows is an optional mode. |
| Runtime | One C runtime for both platforms. The assembly `alan_lib_v2` stays in the repo for reference and is no longer built. |
| Editor intelligence | The extension has its own Alan parser in TypeScript. The compiler adds type errors on save. |
| Toolchain | Self-contained bundle: `alanc` linked statically with LLVM 23, prebuilt runtime, pinned Zig used only as linker and C library. |
| Distribution | VS Code Marketplace, Open VSX, and a `.vsix` on GitHub Releases. |
| Debugger | `alanc build -g` emits DWARF. The extension launches it under LLDB through the CodeLLDB extension (extension dependency). |
| Formatting and rename | Provided by the language server from its own lexer, parser and scopes. |
| Location | Everything lives in the alan-compiler repo. The extension goes in `vscode/`. |

## 1. Components

1. **Compiler `alanc`.** Same compiler with three additions. It is linked statically with LLVM 23. It can write object files directly. It gets two commands, `alanc build file.alan [-o name] [-O]` and `alanc run file.alan [-O]`. The existing `alanc file.alan [-O]` behaviour (IR on standard output) is unchanged, so the `alan` script keeps working.
2. **Runtime `runtime/`.** New C sources for the 14 Alan library functions: `writeInteger`, `writeByte`, `writeChar`, `writeString`, `readInteger`, `readByte`, `readChar`, `readString`, `extend`, `shrink`, `strlen`, `strcmp`, `strcpy`, `strcat`. Compiled with `zig cc` into `libalanrt.a` per target.
3. **Toolchain bundle.** Release assets `alan-<version>-<os>-<arch>.zip` (Windows) and `.tar.gz` (Linux, macOS) for `windows-x64`, `windows-arm64`, `linux-x64`, `linux-arm64`, `macos-x64` and `macos-arm64`, holding `alanc`, `libalanrt.a`, a pinned Zig toolchain and a README. `alanc` finds Zig and the runtime relative to its own executable.
4. **VS Code extension `vscode/`.** TextMate grammar, a TypeScript language server with its own parser, commands to install the compiler, run, build and show IR, and settings.

Run flow: the extension saves the file, calls `alanc run file.alan` in an "Alan" terminal, `alanc` parses, checks, emits an object file, links it with `libalanrt.a` through the bundled `zig cc`, and runs the program in the same terminal so input and output work.

## 2. Compiler and runtime changes

- **Builds.** Linux x64 and ARM64: official LLVM 23 packages, built inside `ubuntu:20.04` so `alanc` needs only glibc 2.31 or newer. Windows x64 and ARM64: MSVC against the official LLVM 23 Windows packages, with win_flex_bison. macOS ARM64 and x64: both builds compile LLVM 23 from source with deployment target 12.0 (x64 on GitHub's Intel macOS runner), cached per architecture, and `alanc` links only system libraries, so it runs on macOS 12 and later. LLVM is linked statically everywhere.
- **Object output.** `alanc build` creates a `TargetMachine` for the host target and writes an object file. It initialises the X86 and AArch64 back ends. Link targets: `x86_64-windows-gnu`, `aarch64-windows-gnu`, `x86_64-linux-musl`, `aarch64-linux-musl`, `x86_64-macos`, `aarch64-macos`. Linking runs `zig cc -target <triple> <obj> <runtime>/libalanrt.a -o <out>`. Linux executables are static and run on any distribution.
- **Debug information.** `alanc build -g` and `alanc run -g` use LLVM's `DIBuilder` to emit a compile unit, a subprogram per Alan function (nested functions included), a line location for every statement and expression, and variables for parameters, locals and arrays with basic types `int` (signed 32-bit) and `byte` (unsigned 8-bit). Debug builds turn optimisation off. Objects carry DWARF on all platforms, and on macOS `zig cc` keeps the debug map so LLDB finds it.
- **Symbol names.** The runtime exports `alan_`-prefixed symbols (for example `alan_strlen`) so they do not clash with the C library. Only the LLVM function names in the `funLibrary` declarations in `ast.cpp` change. The Alan-visible names in the symbol table stay the same, so Alan source code does not change.
- **Types and behaviour.** The C functions use exactly the LLVM types the compiler declares today (for example `writeInteger(i32)`). Behaviour copies the assembly runtime: integer and byte widths, `readString` size limit and newline handling, output formatting. Differences found by the example tests are fixed in the C runtime, never in the expected files.
- **Error format.** Syntax errors change from "Alan error: ... Aborting, I've had enough with line N" to `file:line: error: message`, the format semantic errors already use in `error.cpp`. ANSI colours are printed only when standard error is a terminal.
- **Check mode.** `alanc check file.alan` parses and type-checks without code generation and exits with status 0 or 1. The extension uses it on save.
- **Compatibility.** `alan`, `do.sh` and `alan_lib_v2/` stay as they are and keep working on Linux with a system LLVM 23.

## 3. Installer

- **From VS Code.** When an `.alan` file opens and no compiler is found, a notification offers "Install Alan compiler". The command "Alan: Install or Update Compiler" does the same. It reads the latest `v*` release from the GitHub API, downloads the bundle for the OS and CPU (`process.platform`, `process.arch`), checks it against `SHA256SUMS`, and extracts it into the extension's global storage. No admin rights. A progress notification shows the download.
- **Without VS Code.** `install/install.ps1` (Windows, x64 or ARM64) installs to `%LOCALAPPDATA%\alan` and adds it to the user PATH. `install/install.sh` (Linux and macOS, x64 or ARM64, detected with `uname -s` and `uname -m`) installs to `~/.local/share/alan` and links `alanc` into `~/.local/bin`. On macOS both the script and the extension remove the `com.apple.quarantine` attribute from the extracted bundle. Usage is documented as `irm <raw url>/install.ps1 | iex` and `curl -fsSL <raw url>/install.sh | sh`. Both print how to uninstall.
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
  - Rename, find all references and document highlights from the scope analysis. Rename refuses keywords, library names, invalid identifiers and names that would clash with a declaration in scope.
  - Formatting of a document or a selection, and format on save when the editor setting is on. It works on the token stream with comments kept, re-indents by nesting, puts one statement per line, uses single spaces around binary operators and after commas and none before `(` in calls, keeps at most one blank line, and follows the editor's tab settings. It does nothing when the file has syntax errors.
- **Commands.** "Alan: Run" (editor title play button and a task for F5), "Alan: Build", "Alan: Show IR" (side editor), "Alan: Install or Update Compiler", "Alan: Remove Installed Compiler". Run and Build save the file first and send compile errors to the Problems panel.
- **Debugging.** Debug type `alan` with a configuration provider, so F5 on an `.alan` file needs no `launch.json`. It builds with `-g` into a temporary folder and starts a CodeLLDB `lldb` launch configuration with the program in the integrated terminal. CodeLLDB (`vadimcn.vscode-lldb`) is listed in `extensionDependencies`. Breakpoints, stepping, call stack and Alan variables work on all six platforms.
- **Settings.** `alan.compilerPath`, `alan.optimize` (default true, passes `-O`), `alan.useWsl`, `alan.checkOnSave` (default true).

## 5. Testing, CI and publishing

- **Compiler and runtime tests (`tests/`).** Each example runs through `alanc run` with a fixed input file. Output is compared with expected files recorded from the current verified build (LLVM 23 with the assembly runtime). Error tests check `file:line: error` messages for broken programs, including `Examples/test2`. Run on Linux and Windows in CI.
- **Parser tests.** Every file in `Examples/` except the intentional error file parses with no diagnostics. A set of broken snippets produces the expected messages and ranges.
- **Formatter and rename tests.** Formatting every example twice gives the same text both times, keeps every comment, and the formatted examples still pass the example harness. Rename tests cover shadowing, clashes and refused names.
- **Debugger tests.** A CI test builds an example with `-g`, runs LLDB in batch mode with a breakpoint on an Alan line, and checks the stop location and a variable value.
- **Extension tests.** `@vscode/test-electron` opens examples and checks completion items, hover text and diagnostics. The install command is tested against a local fake release server.
- **Installer tests.** CI runs `install.sh` on Ubuntu and `install.ps1` on Windows against the built bundle, then `alanc run Examples/HelloWorld.alan`.
- **Workflows.** `ci.yml` on every push and pull request builds and tests everything on six runners (`windows-latest`, `windows-11-arm`, `ubuntu-latest`, `ubuntu-24.04-arm`, `macos-latest`, and GitHub's Intel macOS runner). `release.yml` (replacing the current one) runs on `v*` tags, builds all six bundles, writes `SHA256SUMS`, tests the packaged bundles and publishes the release. `vscode-release.yml` runs on `vscode-v*` tags, packages the `.vsix`, attaches it to a release, and publishes to the Marketplace (`VSCE_PAT`, publisher `sleousis`) and Open VSX (`OVSX_PAT`). Publishing steps are skipped with a warning when a token is missing.
- **User setup, once.** Create the Marketplace publisher `sleousis` and add an Azure DevOps token as repo secret `VSCE_PAT`. Create an Open VSX token as `OVSX_PAT`.
- **Docs.** Root README gets "Install" and "Editor support" sections. `vscode/README.md` is the Marketplace page with a screenshot and an animated demo.

## Out of scope

- Rewriting the compiler or changing the Alan language.
