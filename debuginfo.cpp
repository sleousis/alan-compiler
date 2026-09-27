#include "debuginfo.hpp"
#include "llvm/ADT/SmallString.h"
#include "llvm/BinaryFormat/Dwarf.h"
#include "llvm/IR/DIBuilder.h"
#include "llvm/IR/DebugInfoMetadata.h"
#include "llvm/Support/FileSystem.h"
#include "llvm/Support/Path.h"

using namespace llvm;

namespace {
/* A function whose debug information is being generated. */
struct OpenFunction {
  DISubprogram *sp;
  std::vector<std::string> params;
  size_t nextParam;
};
}

struct DebugInfo {
  Module &m;
  DIBuilder b;
  DIFile *file = nullptr;
  DIBasicType *intTy = nullptr;
  DIBasicType *byteTy = nullptr;
  std::vector<OpenFunction> open;
  explicit DebugInfo(Module &mod) : m(mod), b(mod) {}
};

DebugInfo *di_begin(Module &m, const char *filePath) {
  if (!filePath) return nullptr;
  DebugInfo *d = new DebugInfo(m);
  SmallString<256> path(filePath);
  sys::fs::make_absolute(path);
  sys::path::remove_dots(path, true);
  d->file = d->b.createFile(sys::path::filename(path), sys::path::parent_path(path));
  d->b.createCompileUnit(DISourceLanguageName(dwarf::DW_LANG_C), d->file, ALAN_DWARF_PRODUCER,
                         /*isOptimized*/ false, "", 0);
  d->intTy = d->b.createBasicType("int", 32, dwarf::DW_ATE_signed);
  d->byteTy = d->b.createBasicType("byte", 8, dwarf::DW_ATE_unsigned_char);
  m.addModuleFlag(Module::Warning, "Debug Info Version",
                  static_cast<uint32_t>(DEBUG_METADATA_VERSION));
  m.addModuleFlag(Module::Warning, "Dwarf Version", static_cast<uint32_t>(4));
  /* Windows objects would otherwise carry CodeView, which LLDB does not read
     from a MinGW executable. */
  m.addModuleFlag(Module::Warning, "CodeView", static_cast<uint32_t>(0));
  return d;
}

/* The debug type of an LLVM type in a signature. References and arrays are
   passed as untyped pointers. */
static DIType *signature_type(DebugInfo *d, Type *t) {
  if (t->isIntegerTy(32)) return d->intTy;
  if (t->isIntegerTy(8)) return d->byteTy;
  if (t->isPointerTy())
    return d->b.createPointerType(nullptr, d->m.getDataLayout().getPointerSizeInBits());
  return nullptr;
}

void di_function(DebugInfo *d, Function *f, const char *name, unsigned line,
                 const std::vector<std::pair<std::string, Type *>> &params) {
  if (!d) return;
  std::vector<Metadata *> types = {signature_type(d, f->getReturnType())};
  std::vector<std::string> names;
  for (const auto &p : params) {
    types.push_back(signature_type(d, p.second));
    names.push_back(p.first);
  }
  DIScope *scope = d->open.empty() ? static_cast<DIScope *>(d->file) : d->open.back().sp;
  /* No linkage name: the program's main is main.1 in LLVM, and LLDB on
     macOS would show that name in the frames. */
  DISubprogram *sp = d->b.createFunction(
      scope, name, StringRef(), d->file, line,
      d->b.createSubroutineType(d->b.getOrCreateTypeArray(types)), line,
      DINode::FlagPrototyped, DISubprogram::SPFlagDefinition);
  f->setSubprogram(sp);
  d->open.push_back({sp, names, 0});
}

void di_variable(DebugInfo *d, AllocaInst *slot, const char *name, unsigned line,
                 bool isByte, bool isArray, unsigned arraySize, bool isRef) {
  if (!d || d->open.empty()) return;
  OpenFunction &fn = d->open.back();
  DIType *elem = isByte ? d->byteTy : d->intTy;
  DIType *type = elem;
  if (isArray && arraySize > 0) {
    uint64_t bits = elem->getSizeInBits();
    type = d->b.createArrayType(arraySize * bits, static_cast<uint32_t>(bits), elem,
                                d->b.getOrCreateArray({d->b.getOrCreateSubrange(0, arraySize)}));
  } else if (isArray) {
    type = d->b.createPointerType(elem, d->m.getDataLayout().getPointerSizeInBits());
  }
  DILocalVariable *var;
  if (fn.nextParam < fn.params.size() && fn.params[fn.nextParam] == name) {
    fn.nextParam++;
    var = d->b.createParameterVariable(fn.sp, name, static_cast<unsigned>(fn.nextParam),
                                       d->file, line, type, true);
  } else {
    var = d->b.createAutoVariable(fn.sp, name, d->file, line, type, true);
  }
  /* A reference holds the address of the variable, so the value is one
     load further. */
  DIExpression *expr = isRef && !isArray ? d->b.createExpression(ArrayRef<uint64_t>{dwarf::DW_OP_deref})
                                         : d->b.createExpression();
  d->b.insertDeclare(slot, var, expr,
                     DILocation::get(d->m.getContext(), line, 0, fn.sp),
                     slot->getParent());
}

void di_location(DebugInfo *d, IRBuilder<> &b, unsigned line) {
  if (!d || d->open.empty()) return;
  b.SetCurrentDebugLocation(DILocation::get(d->m.getContext(), line, 0, d->open.back().sp));
}

void di_end_function(DebugInfo *d) {
  if (!d || d->open.empty()) return;
  d->b.finalizeSubprogram(d->open.back().sp);
  d->open.pop_back();
}

void di_finish(DebugInfo *d) {
  if (!d) return;
  d->b.finalize();
  delete d;
}
