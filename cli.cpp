#include "cli.hpp"
#include <cstring>
#include <cstdio>
#include "llvm/IR/Module.h"
#include "llvm/Support/raw_ostream.h"

int compile_to_module(const char *path, bool opt, bool codegen);
llvm::Module *alan_module();

static int usage() {
  fprintf(stderr,
    "usage: alanc <file.alan> [-O]           print LLVM IR\n"
    "       alanc check <file.alan>          check only\n"
    "       alanc build <file.alan> [-o name] [-O]\n"
    "       alanc run <file.alan> [-O]\n");
  return 2;
}

int alan_cli_main(int argc, char **argv) {
  if (argc >= 3 && strcmp(argv[1], "check") == 0)
    return compile_to_module(argv[2], false, false);
  if (argc == 2 || (argc == 3 && strcmp(argv[2], "-O") == 0)) {
    int r = compile_to_module(argv[1], argc == 3, true);
    if (r == 0) alan_module()->print(llvm::outs(), nullptr);
    return r;
  }
  return usage();
}
