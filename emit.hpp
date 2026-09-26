#ifndef __EMIT_HPP__
#define __EMIT_HPP__

#include <string>
#include "llvm/IR/Module.h"

/* Writes module m as a native object file for the target triple to outPath.
   Sets the module's triple and data layout. On failure returns false and
   puts the reason in err. */
bool emit_object(llvm::Module &m, const std::string &triple,
                 const std::string &outPath, std::string &err);

#endif
