Alan compiler

This folder holds everything needed to compile and run Alan programs.
Nothing else has to be installed.

  bin/alanc        the compiler (alanc.exe on Windows)
  lib/libalanrt.a  the runtime library that programs link with
  zig/             the Zig toolchain, used only to link programs
  VERSION          the release this folder comes from

Getting started

Add the bin folder to your PATH, then run a program:

  alanc run hello.alan

Replace <folder> below with the folder where you extracted alan.

On Linux and macOS:

  export PATH="<folder>/alan/bin:$PATH"

On Windows, in PowerShell:

  $env:Path = "<folder>\alan\bin;" + $env:Path

To keep it, add the bin folder to PATH in your shell profile or in the
Windows environment variable settings.

Commands

  alanc run <file.alan> [-O]                compile, link and run the program
  alanc build <file.alan> [-o name] [-O]    compile and link an executable
  alanc check <file.alan>                   check the program for errors only
  alanc <file.alan> [-O]                    print the LLVM IR

-O turns on optimization.

Notes

Keep the folder together. alanc finds the runtime in ../lib and Zig in
../zig next to its own bin folder. You can point it elsewhere with the
ALAN_RUNTIME and ALAN_ZIG environment variables.

The first program you build takes a minute or two longer, because Zig
prepares its C library once and keeps it in its cache.

macOS marks downloaded files as quarantined. If macOS refuses to open
alanc, run this once in the folder that holds alan:

  xattr -dr com.apple.quarantine alan
