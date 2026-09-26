#!/bin/sh

if [ "$1" != "" ]; then
    echo "Compiling $1"
    ./alanc $1 > a.ll || exit 1
    llc a.ll -o a.s
    # alanc calls the runtime by alan_-prefixed names. The assembly runtime in
    # lib.a has the plain names, so load them (-u) and alias the prefixed names.
    RUNTIME_ALIASES=""
    for f in writeInteger writeByte writeChar writeString readInteger readByte \
             readChar readString extend shrink strlen strcmp strcpy strcat; do
      RUNTIME_ALIASES="$RUNTIME_ALIASES,-u,$f,--defsym,alan_$f=$f"
    done
    clang a.s alan_lib_v2/lib.a -no-pie -Wl,-z,noseparate-code"$RUNTIME_ALIASES" -o a.out
fi
