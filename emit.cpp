#include "emit.hpp"
#include "llvm/IR/LegacyPassManager.h"
#include "llvm/MC/TargetRegistry.h"
#include "llvm/Support/FileSystem.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Target/TargetMachine.h"
#include "llvm/Target/TargetOptions.h"
#include "llvm/TargetParser/Triple.h"
#include <memory>

/* Both back ends are linked into every alanc, so any build can emit code
   for either CPU. */
extern "C" {
void LLVMInitializeX86TargetInfo();
void LLVMInitializeX86Target();
void LLVMInitializeX86TargetMC();
void LLVMInitializeX86AsmPrinter();
void LLVMInitializeAArch64TargetInfo();
void LLVMInitializeAArch64Target();
void LLVMInitializeAArch64TargetMC();
void LLVMInitializeAArch64AsmPrinter();
}

static void init_targets() {
  static bool done = false;
  if (done) return;
  done = true;
  LLVMInitializeX86TargetInfo();
  LLVMInitializeX86Target();
  LLVMInitializeX86TargetMC();
  LLVMInitializeX86AsmPrinter();
  LLVMInitializeAArch64TargetInfo();
  LLVMInitializeAArch64Target();
  LLVMInitializeAArch64TargetMC();
  LLVMInitializeAArch64AsmPrinter();
}

bool emit_object(llvm::Module &m, const std::string &triple,
                 const std::string &outPath, std::string &err) {
  init_targets();
  llvm::Triple t(triple);
  const llvm::Target *target = llvm::TargetRegistry::lookupTarget(t, err);
  if (!target) return false;
  llvm::TargetOptions opts;
  const char *cpu = t.isAArch64() ? "generic" : "x86-64";
  std::unique_ptr<llvm::TargetMachine> tm(target->createTargetMachine(
      t, cpu, "", opts, llvm::Reloc::PIC_));
  if (!tm) {
    err = "cannot create a target machine for " + triple;
    return false;
  }
  m.setTargetTriple(t);
  m.setDataLayout(tm->createDataLayout());
  std::error_code ec;
  llvm::raw_fd_ostream out(outPath, ec, llvm::sys::fs::OF_None);
  if (ec) {
    err = outPath + ": " + ec.message();
    return false;
  }
  llvm::legacy::PassManager pm;
  if (tm->addPassesToEmitFile(pm, out, nullptr,
                              llvm::CodeGenFileType::ObjectFile)) {
    err = "target cannot emit object files";
    return false;
  }
  pm.run(m);
  out.flush();
  if (out.has_error()) {
    err = outPath + ": " + out.error().message();
    out.clear_error();
    return false;
  }
  return true;
}
