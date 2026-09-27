#include "cli.hpp"
#include "debuginfo.hpp"
#include "emit.hpp"
#include "error.hpp"
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <optional>
#include <string>
#include <thread>
#include <vector>
#include "llvm/ADT/SmallString.h"
#include "llvm/IR/Module.h"
#include "llvm/Support/FileSystem.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/Path.h"
#include "llvm/Support/Process.h"
#include "llvm/Support/Program.h"
#include "llvm/Support/Signals.h"
#include "llvm/Support/raw_ostream.h"
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#endif

int compile_to_module(const char *path, bool opt, bool codegen, bool debug);
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
/* Whether a debug build keeps its object file, where LLDB finds the DWARF
   through the executable's debug map. */
#ifdef __APPLE__
static const bool kKeepObject = true;
#else
static const bool kKeepObject = false;
#endif
/* The version that --version prints when alanc runs outside a bundle. The
   build sets it (CMake option ALAN_VERSION). */
#ifndef ALAN_VERSION
#define ALAN_VERSION "dev"
#endif

static int usage() {
  fprintf(stderr,
    "usage: alanc <file.alan> [-O]           print LLVM IR\n"
    "       alanc check <file.alan>          check only\n"
    "       alanc build <file.alan> [-o name] [-O] [-g]\n"
    "       alanc run <file.alan> [-O] [-g]\n"
    "       alanc --version\n");
  return 2;
}

static void cli_error(const char *where, const std::string &msg) {
  bool tty = stderr_is_tty();
  fprintf(stderr, "%s: %serror:%s %s\n", where, tty ? "\033[1;31m" : "",
          tty ? "\033[0m" : "", msg.c_str());
}

/* Exit status of alanc after Ctrl-C, as a shell gives for SIGINT. */
static const int kInterruptedExit = 130;

/* While a child process runs, Ctrl-C only sets a flag in alanc, so alanc
   lives on to stop the child and remove its temporary files. A handler
   that catches a signal is reset in the child, so the child still stops on
   a Ctrl-C from the terminal. */
class InterruptGuard {
 public:
  InterruptGuard() {
    interrupted_ = 0;
#ifdef _WIN32
    SetConsoleCtrlHandler(on_ctrl, TRUE);
#else
    struct sigaction sa = {};
    sa.sa_handler = on_signal;
    sa.sa_flags = SA_RESTART;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGINT, &sa, &old_);
#endif
  }
  ~InterruptGuard() {
#ifdef _WIN32
    SetConsoleCtrlHandler(on_ctrl, FALSE);
#else
    sigaction(SIGINT, &old_, nullptr);
#endif
  }
  InterruptGuard(const InterruptGuard &) = delete;
  InterruptGuard &operator=(const InterruptGuard &) = delete;
  static bool interrupted() { return interrupted_ != 0; }

 private:
  static volatile std::sig_atomic_t interrupted_;
#ifdef _WIN32
  static BOOL WINAPI on_ctrl(DWORD type) {
    if (type != CTRL_C_EVENT && type != CTRL_BREAK_EVENT) return FALSE;
    interrupted_ = 1;
    return TRUE;
  }
#else
  static void on_signal(int) { interrupted_ = 1; }
  struct sigaction old_;
#endif
};
volatile std::sig_atomic_t InterruptGuard::interrupted_ = 0;

#ifdef _WIN32
/* The exit code of a Windows program that Ctrl-C stopped. */
static const DWORD kControlCExit = 0xC000013AUL;
#endif

/* Stops a child after a Ctrl-C that alanc got. hard makes sure it ends. */
static void stop_child(const llvm::sys::ProcessInfo &pi, bool hard) {
#ifdef _WIN32
  /* Windows cannot send Ctrl-C to one process, so the child ends as if
     Ctrl-C had stopped it. */
  (void)hard;
  TerminateProcess(pi.Process, kControlCExit);
#else
  kill(pi.Pid, hard ? SIGKILL : SIGINT);
#endif
}

/* True when a child with this result ended because of Ctrl-C. A child
   that alanc stopped counts too, unless it still exited normally. */
static bool ended_by_interrupt(int rc, const std::string &err, bool stopped) {
#ifdef _WIN32
  (void)err;
  (void)stopped;
  return rc == static_cast<int>(kControlCExit);
#else
  /* -2 means the child ended from a signal, and err names the signal as
     strsignal gives it. */
  if (rc != -2) return false;
  return stopped || err == strsignal(SIGINT);
#endif
}

/* Runs a program and waits for it. A Ctrl-C that alanc gets meanwhile is
   passed on to the program. interrupted tells whether the program ended
   because of Ctrl-C. The result is as for ExecuteAndWait. */
static int run_child(llvm::StringRef program, llvm::ArrayRef<llvm::StringRef> args,
                     std::string &err, bool &interrupted) {
  using namespace std::chrono;
  interrupted = false;
  InterruptGuard guard;
  bool failed = false;
  llvm::sys::ProcessInfo pi =
      llvm::sys::ExecuteNoWait(program, args, std::nullopt, {}, 0, &err, &failed);
  if (failed || pi.Pid == llvm::sys::ProcessInfo::InvalidPid) return -1;
  bool stopped = false, killed = false;
  steady_clock::time_point stoppedAt;
  llvm::sys::ProcessInfo result;
  for (;;) {
    /* Polling: returns at once and never kills the child. */
    result = llvm::sys::Wait(pi, 0, &err, nullptr, /*Polling*/ true);
    if (result.Pid != llvm::sys::ProcessInfo::InvalidPid) break;
    if (InterruptGuard::interrupted()) {
      if (!stopped) {
        stop_child(pi, false);
        stopped = true;
        stoppedAt = steady_clock::now();
      } else if (!killed && steady_clock::now() - stoppedAt > seconds(2)) {
        stop_child(pi, true);
        killed = true;
      }
    }
    std::this_thread::sleep_for(milliseconds(20));
  }
  interrupted = ended_by_interrupt(result.ReturnCode, err, stopped);
  return result.ReturnCode;
}

/* A temporary file is also removed when a signal stops alanc. */
static void track_temp(llvm::StringRef path) {
  llvm::sys::RemoveFileOnSignal(path);
}

static void remove_temp(llvm::StringRef path) {
  llvm::sys::fs::remove(path);
  llvm::sys::DontRemoveFileOnSignal(path);
}

/* True when src can be read. Otherwise it says why. fopen opens a directory
   on some systems, so a directory is caught here. */
static bool source_readable(const char *src) {
  std::error_code ec;
  if (llvm::sys::fs::is_directory(src)) {
    ec = std::make_error_code(std::errc::is_a_directory);
  } else {
    int fd;
    ec = llvm::sys::fs::openFileForRead(src, fd);
    if (!ec) llvm::sys::Process::SafelyCloseFileDescriptor(fd);
  }
  if (!ec) return true;
  cli_error("alanc", std::string("cannot open ") + src + ": " + ec.message());
  return false;
}

static std::string self_dir(const char *argv0) {
  std::string p = llvm::sys::fs::getMainExecutable(argv0, (void *)&self_dir);
  return llvm::sys::path::parent_path(p).str();
}

/* The version of alanc: the first line of the bundle's VERSION file, next
   to bin/, or else the version set at build time. */
static std::string alan_version(const char *argv0) {
  llvm::SmallString<256> p(self_dir(argv0));
  llvm::sys::path::append(p, "..", "VERSION");
  if (auto buf = llvm::MemoryBuffer::getFile(p, /*IsText*/ true)) {
    llvm::StringRef v = (*buf)->getBuffer().split('\n').first.trim();
    if (!v.empty()) return v.str();
  }
  return ALAN_VERSION;
}

/* A bundled tool: the environment variable wins, otherwise the path rel
   from the directory that holds alanc. */
static std::string find_tool(const char *env, const std::string &rel,
                             const char *argv0) {
  /* GetEnv reads the variable as UTF-8, also on Windows. */
  if (std::optional<std::string> e = llvm::sys::Process::GetEnv(env))
    if (!e->empty()) return *e;
  llvm::SmallString<256> p(self_dir(argv0));
  llvm::sys::path::append(p, rel);
  return std::string(p);
}

/* Options shared by build and run. */
struct BuildOptions {
  const char *src = nullptr;
  std::string out;
  bool opt = false;
  /* -g: DWARF debug information, which turns -O off. */
  bool debug = false;
};

/* Parses "<file> [options]" after the command name. Returns false on a
   malformed command line. allowOut says whether -o is accepted. */
static bool parse_build_options(int argc, char **argv, bool allowOut,
                                BuildOptions &o) {
  for (int i = 2; i < argc; i++) {
    const char *a = argv[i];
    if (strcmp(a, "-O") == 0) {
      o.opt = true;
    } else if (strcmp(a, "-g") == 0) {
      o.debug = true;
    } else if (allowOut && strcmp(a, "-o") == 0) {
      if (++i >= argc) return false;
      o.out = argv[i];
    } else if (a[0] == '-' || o.src) {
      return false;
    } else {
      o.src = a;
    }
  }
  if (o.debug) o.opt = false;
  return o.src != nullptr;
}

/* Emits the compiled module and links it with the runtime into the
   executable out. The object goes to keptObj when that is not empty and
   stays there, otherwise to a temporary file. debug keeps the debug
   information in out. */
static int link_module(const char *argv0, const char *src,
                       const std::string &out, const std::string &keptObj,
                       bool debug) {
  llvm::SmallString<256> obj(keptObj);
  if (keptObj.empty()) {
    if (std::error_code ec = llvm::sys::fs::createTemporaryFile("alan", "o", obj)) {
      cli_error(src, "cannot create a temporary file: " + ec.message());
      return 1;
    }
    track_temp(obj);
  }
  std::string err;
  if (!emit_object(*alan_module(), kTriple, std::string(obj), err)) {
    if (keptObj.empty()) remove_temp(obj);
    else llvm::sys::fs::remove(obj);
    cli_error(src, err);
    return 1;
  }
  std::string zig = find_tool("ALAN_ZIG", std::string("../zig/zig") + kExe, argv0);
  std::string rt = find_tool("ALAN_RUNTIME", "../lib/libalanrt.a", argv0);
  std::vector<std::string> args = {zig, "cc", "-target", kTriple,
                                   std::string(obj), rt, "-o", out};
#ifdef _WIN32
  /* Without -s the Windows linker writes a .pdb next to the output. A debug
     build needs the DWARF that -s strips, so it removes the .pdb below. */
  if (!debug) args.push_back("-s");
#else
  (void)debug;
#endif
  std::vector<llvm::StringRef> refs(args.begin(), args.end());
  std::string execErr;
  bool interrupted = false;
  int rc = run_child(zig, refs, execErr, interrupted);
  if (keptObj.empty()) remove_temp(obj);
#ifdef _WIN32
  if (debug) {
    /* The .pdb holds only the symbol names, and LLDB reads the DWARF in
       the executable. */
    llvm::SmallString<256> pdb(out);
    llvm::sys::path::replace_extension(pdb, "pdb");
    llvm::sys::fs::remove(pdb);
  }
#endif
  if (interrupted) return kInterruptedExit;
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

/* True when the file at path holds alanc's DWARF producer, which only the
   objects that alanc keeps for a debug build do. */
static bool is_alanc_object(const std::string &path) {
  uint64_t size = 0;
  if (llvm::sys::fs::file_size(path, size) || size > (256u << 20)) return false;
  auto buf = llvm::MemoryBuffer::getFile(path);
  if (!buf) return false;
  /* the string with its terminating NUL, as it sits in __debug_str */
  llvm::StringRef mark(ALAN_DWARF_PRODUCER, sizeof(ALAN_DWARF_PRODUCER));
  return (*buf)->getBuffer().contains(mark);
}

/* True when out names the source file itself. */
static bool is_source(const char *src, const std::string &out) {
  if (out == src) return true;
  bool same = false;
  return !llvm::sys::fs::equivalent(src, out, same) && same;
}

static int cmd_build(const char *argv0, const BuildOptions &o) {
  if (!source_readable(o.src)) return 1;
  std::string out = o.out.empty() ? default_output(o.src) : o.out;
  if (is_source(o.src, out)) {
    cli_error(o.src, o.out.empty()
                         ? "cannot choose an output name, use -o"
                         : "the output file is the source file, use another -o");
    return 1;
  }
  /* On macOS the executable does not hold the DWARF. LLDB reads it from the
     object, which the executable names, so the object stays next to it. A
     file of that name that alanc did not make is never overwritten. */
  std::string keptObj = kKeepObject && o.debug ? out + ".o" : "";
  if (!keptObj.empty() && llvm::sys::fs::exists(keptObj) && !is_alanc_object(keptObj)) {
    cli_error(o.src, keptObj + " exists and alanc did not make it, so a debug build "
                     "cannot keep its object there. Move it or use another -o");
    return 1;
  }
  if (compile_to_module(o.src, o.opt, true, o.debug) != 0) return 1;
  return link_module(argv0, o.src, out, keptObj, o.debug);
}

/* Builds into a temporary executable, runs it with the standard streams
   inherited and returns its exit status. */
static int cmd_run(const char *argv0, const BuildOptions &o) {
  if (!source_readable(o.src)) return 1;
  /* Compile first: some compile errors exit the process, which would leave
     the temporary file behind. */
  if (compile_to_module(o.src, o.opt, true, o.debug) != 0) return 1;
  llvm::SmallString<256> exe;
  if (std::error_code ec =
          llvm::sys::fs::createTemporaryFile("alan", kExe[0] ? kExe + 1 : "", exe)) {
    cli_error(o.src, "cannot create a temporary file: " + ec.message());
    return 1;
  }
  std::string path(exe);
  track_temp(path);
  /* On macOS the object must outlive the program for a debugger to read its
     DWARF (see cmd_build). */
  std::string keptObj = kKeepObject && o.debug ? path + ".o" : "";
  if (!keptObj.empty()) track_temp(keptObj);
  auto cleanup = [&] {
    remove_temp(path);
    if (!keptObj.empty()) remove_temp(keptObj);
  };
  int rc = link_module(argv0, o.src, path, keptObj, o.debug);
  if (rc != 0) {
    cleanup();
    return rc;
  }
#ifndef _WIN32
  /* The temporary file is created without execute permission, and zig's
     Mach-O linker keeps the mode of the file it overwrites. */
  if (std::error_code ec =
          llvm::sys::fs::setPermissions(path, llvm::sys::fs::owner_all)) {
    cleanup();
    cli_error(o.src, "cannot make the program executable: " + ec.message());
    return 1;
  }
#endif
  std::vector<llvm::StringRef> refs = {path};
  std::string execErr;
  bool interrupted = false;
  rc = run_child(path, refs, execErr, interrupted);
  cleanup();
  if (interrupted) return kInterruptedExit;
  if (rc < 0) {
    cli_error(o.src, "program did not finish: " + execErr);
    return 1;
  }
  return rc;
}

int alan_cli_main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    llvm::outs() << "alanc " << alan_version(argv[0]) << "\n";
    return 0;
  }
  if (argc >= 2 && strcmp(argv[1], "check") == 0) {
    if (argc != 3 || argv[2][0] == '-') return usage();
    if (!source_readable(argv[2])) return 1;
    return compile_to_module(argv[2], false, false, false);
  }
  if (argc >= 2 && (strcmp(argv[1], "build") == 0 || strcmp(argv[1], "run") == 0)) {
    bool isBuild = strcmp(argv[1], "build") == 0;
    BuildOptions o;
    if (!parse_build_options(argc, argv, isBuild, o)) return usage();
    return isBuild ? cmd_build(argv[0], o) : cmd_run(argv[0], o);
  }
  /* -h, --help and any other option in place of the file */
  if (argc < 2 || argv[1][0] == '-') return usage();
  if (argc == 2 || (argc == 3 && strcmp(argv[2], "-O") == 0)) {
    if (!source_readable(argv[1])) return 1;
    int r = compile_to_module(argv[1], argc == 3, true, false);
    if (r == 0) alan_module()->print(llvm::outs(), nullptr);
    return r;
  }
  return usage();
}
