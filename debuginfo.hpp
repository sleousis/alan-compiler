#ifndef __DEBUGINFO_HPP__
#define __DEBUGINFO_HPP__

#include <string>
#include <utility>
#include <vector>
#include "llvm/IR/Function.h"
#include "llvm/IR/IRBuilder.h"
#include "llvm/IR/Instructions.h"
#include "llvm/IR/Module.h"

/* DWARF debug information for the generated module. Every function takes
   the DebugInfo that di_begin returned and does nothing when it is null, so
   the code generator calls them the same way with and without -g. */
struct DebugInfo;

/* DW_AT_producer of the compile unit. alanc also looks for it on macOS to
   tell the object files it keeps from other files. */
#define ALAN_DWARF_PRODUCER "Alan compiler (alanc)"

/* Starts debug information for module m compiled from filePath. The caller
   passes filePath only for -g, and keeps nullptr otherwise. */
DebugInfo *di_begin(llvm::Module &m, const char *filePath);

/* Starts function f, called name in the source and declared on line. params
   are the parameters the program declares, in order, without the hidden
   ones that carry outer variables. A function defined while another one is
   open is nested in it. */
void di_function(DebugInfo *d, llvm::Function *f, const char *name, unsigned line,
                 const std::vector<std::pair<std::string, llvm::Type *>> &params);

/* Describes the variable name that lives in slot. Calls for the parameters
   of the open function come first, in their order. An array of unknown size
   (arraySize 0) is a parameter whose slot holds a pointer to its first
   element. isRef says that slot holds the address of an int or byte passed
   by reference. */
void di_variable(DebugInfo *d, llvm::AllocaInst *slot, const char *name, unsigned line,
                 bool isByte, bool isArray, unsigned arraySize /* 0 when unknown */,
                 bool isRef = false);

/* Gives the instructions that b creates from now on the source line. */
void di_location(DebugInfo *d, llvm::IRBuilder<> &b, unsigned line);

/* Ends the function that di_function started last. */
void di_end_function(DebugInfo *d);

/* Completes the debug information and frees d. */
void di_finish(DebugInfo *d);

#endif
