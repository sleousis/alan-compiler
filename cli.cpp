#include "cli.hpp"
#include "emit.hpp"
#include "error.hpp"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include "llvm/ADT/SmallString.h"
#include "llvm/IR/Module.h"
#include "llvm/Support/FileSystem.h"
#include "llvm/Support/Path.h"
#include "llvm/Support/Program.h"
#include "llvm/Support/raw_ostream.h"

int compile_to_module(const char *path, bool opt, bool codegen);
llvm::Module *alan_module();

/* Target that alanc builds programs for: the host it runs on. */
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

static int usage() {
  fprintf(stderr,
    "usage: alanc <file.alan> [-O]           print LLVM IR\n"
    "       alanc check <file.alan>          check only\n"
    "       alanc build <file.alan> [-o name] [-O]\n"
    "       alanc run <file.alan> [-O]\n");
  return 2;
}

static void cli_error(const char *where, const std::string &msg) {
  bool tty = stderr_is_tty();
  fprintf(stderr, "%s: %serror:%s %s\n", where, tty ? "\033[1;31m" : "",
          tty ? "\033[0m" : "", msg.c_str());
}

static std::string self_dir(const char *argv0) {
  std::string p = llvm::sys::fs::getMainExecutable(argv0, (void *)&self_dir);
  return llvm::sys::path::parent_path(p).str();
}

/* A bundled tool: the environment variable wins, otherwise the path rel
   from the directory that holds alanc. */
static std::string find_tool(const char *env, const std::string &rel,
                             const char *argv0) {
  if (const char *e = std::getenv(env))
    if (*e) return e;
  llvm::SmallString<256> p(self_dir(argv0));
  llvm::sys::path::append(p, rel);
  return std::string(p);
}

/* Options shared by build and run. */
struct BuildOptions {
  const char *src = nullptr;
  std::string out;
  bool opt = false;
};

/* Parses "<file> [options]" after the command name. Returns false on a
   malformed command line. allowOut says whether -o is accepted. */
static bool parse_build_options(int argc, char **argv, bool allowOut,
                                BuildOptions &o) {
  for (int i = 2; i < argc; i++) {
    const char *a = argv[i];
    if (strcmp(a, "-O") == 0) {
      o.opt = true;
    } else if (allowOut && strcmp(a, "-o") == 0) {
      if (++i >= argc) return false;
      o.out = argv[i];
    } else if (a[0] == '-' || o.src) {
      return false;
    } else {
      o.src = a;
    }
  }
  return o.src != nullptr;
}

/* Emits the compiled module and links it with the runtime into the
   executable out. */
static int link_module(const char *argv0, const char *src,
                       const std::string &out) {
  llvm::SmallString<256> obj;
  if (std::error_code ec = llvm::sys::fs::createTemporaryFile("alan", "o", obj)) {
    cli_error(src, "cannot create a temporary file: " + ec.message());
    return 1;
  }
  std::string err;
  if (!emit_object(*alan_module(), kTriple, std::string(obj), err)) {
    llvm::sys::fs::remove(obj);
    cli_error(src, err);
    return 1;
  }
  std::string zig = find_tool("ALAN_ZIG", std::string("../zig/zig") + kExe, argv0);
  std::string rt = find_tool("ALAN_RUNTIME", "../lib/libalanrt.a", argv0);
  std::vector<std::string> args = {zig, "cc", "-target", kTriple,
                                   std::string(obj), rt, "-o", out};
#ifdef _WIN32
  /* Without -s the Windows linker writes a .pdb next to the output. */
  args.push_back("-s");
#endif
  std::vector<llvm::StringRef> refs(args.begin(), args.end());
  std::string execErr;
  int rc = llvm::sys::ExecuteAndWait(zig, refs, std::nullopt, {}, 0, 0, &execErr);
  llvm::sys::fs::remove(obj);
  if (rc == -1) {
    cli_error(src, "cannot run zig at " + zig + ": " + execErr);
    return 1;
  }
  if (rc < 0) {
    cli_error(src, "zig crashed while linking: " + execErr);
    return 1;
  }
  if (rc != 0) {
    cli_error(src, "linking failed (zig exit " + std::to_string(rc) + ")");
    return 1;
  }
  return 0;
}

/* Default output of build. A file name ending in .alan (and longer than
   that) loses .alan and gains kExe. Any other name gains .exe on Windows
   and .out elsewhere, so the output never replaces the source. */
static std::string default_output(const char *src) {
  std::string out = src;
  llvm::StringRef name = llvm::sys::path::filename(out);
  if (name.ends_with(".alan") && name.size() > 5)
    return out.substr(0, out.size() - 5) + kExe;
  return out + (kExe[0] ? kExe : ".out");
}

/* True when out names the source file itself. */
static bool is_source(const char *src, const std::string &out) {
  if (out == src) return true;
  bool same = false;
  return !llvm::sys::fs::equivalent(src, out, same) && same;
}

static int cmd_build(const char *argv0, const BuildOptions &o) {
  std::string out = o.out.empty() ? default_output(o.src) : o.out;
  if (is_source(o.src, out)) {
    cli_error(o.src, o.out.empty()
                         ? "cannot choose an output name, use -o"
                         : "the output file is the source file, use another -o");
    return 1;
  }
  if (compile_to_module(o.src, o.opt, true) != 0) return 1;
  return link_module(argv0, o.src, out);
}

/* Builds into a temporary executable, runs it with the standard streams
   inherited and returns its exit status. */
static int cmd_run(const char *argv0, const BuildOptions &o) {
  /* Compile first: some compile errors exit the process, which would leave
     the temporary file behind. */
  if (compile_to_module(o.src, o.opt, true) != 0) return 1;
  llvm::SmallString<256> exe;
  if (std::error_code ec =
          llvm::sys::fs::createTemporaryFile("alan", kExe[0] ? kExe + 1 : "", exe)) {
    cli_error(o.src, "cannot create a temporary file: " + ec.message());
    return 1;
  }
  std::string path(exe);
  int rc = link_module(argv0, o.src, path);
  if (rc != 0) {
    llvm::sys::fs::remove(path);
    return rc;
  }
  std::vector<llvm::StringRef> refs = {path};
  std::string execErr;
  rc = llvm::sys::ExecuteAndWait(path, refs, std::nullopt, {}, 0, 0, &execErr);
  llvm::sys::fs::remove(path);
  if (rc < 0) {
    cli_error(o.src, "program did not finish: " + execErr);
    return 1;
  }
  return rc;
}

int alan_cli_main(int argc, char **argv) {
  if (argc >= 3 && strcmp(argv[1], "check") == 0)
    return compile_to_module(argv[2], false, false);
  if (argc >= 2 && (strcmp(argv[1], "build") == 0 || strcmp(argv[1], "run") == 0)) {
    bool isBuild = strcmp(argv[1], "build") == 0;
    BuildOptions o;
    if (!parse_build_options(argc, argv, isBuild, o)) return usage();
    return isBuild ? cmd_build(argv[0], o) : cmd_run(argv[0], o);
  }
  if (argc == 2 || (argc == 3 && strcmp(argv[2], "-O") == 0)) {
    int r = compile_to_module(argv[1], argc == 3, true);
    if (r == 0) alan_module()->print(llvm::outs(), nullptr);
    return r;
  }
  return usage();
}
