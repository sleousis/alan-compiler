#!/bin/sh
# usage: build.sh <zig> <target> <outdir>
set -eu
ZIG="$1"; TARGET="$2"; OUT="$3"
DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"
for f in io str conv; do
  "$ZIG" cc -target "$TARGET" -O2 -std=c17 -c "$DIR/$f.c" -o "$OUT/$f.o"
done
rm -f "$OUT/libalanrt.a"
"$ZIG" ar rcs "$OUT/libalanrt.a" "$OUT/io.o" "$OUT/str.o" "$OUT/conv.o"
rm -f "$OUT"/*.o
