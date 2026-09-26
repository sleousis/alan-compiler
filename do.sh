#!/bin/sh

if [ "$1" != "" ]; then
    echo "Compiling $1"
    ./alanc $1 > a.ll || exit 1
    llc a.ll -o a.s
    clang a.s alan_lib_v2/lib.a -Wl,-z,noseparate-code -o a.out
fi
