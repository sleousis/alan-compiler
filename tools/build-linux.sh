#!/bin/sh
# Builds alanc and libalanrt.a for this Linux host into dist/<platform>/.
# LLVM comes from LLVM_DIR when set, else from /usr/lib/llvm-23, else from
# the official LLVM release package. The runtime is built with zig
# (ALAN_ZIG, or zig on the PATH).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tools/versions.env"
case "$(uname -m)" in
  x86_64) PLATFORM=linux-x64; PKG=X64; TARGET=x86_64-linux-musl ;;
  aarch64|arm64) PLATFORM=linux-arm64; PKG=ARM64; TARGET=aarch64-linux-musl ;;
  *) echo "unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac
ZIG="${ALAN_ZIG:-zig}"

if [ -z "${LLVM_DIR:-}" ]; then
  if [ -d /usr/lib/llvm-23/lib/cmake/llvm ]; then
    LLVM_DIR=/usr/lib/llvm-23/lib/cmake/llvm
  else
    NAME="LLVM-$LLVM_VERSION-Linux-$PKG"
    TMP="${RUNNER_TEMP:-/tmp}"
    if [ ! -d "$TMP/$NAME" ]; then
      curl -fsSL -o "$TMP/$NAME.tar.xz" \
        "https://github.com/llvm/llvm-project/releases/download/llvmorg-$LLVM_VERSION/$NAME.tar.xz"
      # Clang, MLIR, LLDB and Flang libraries are not needed.
      tar -xJf "$TMP/$NAME.tar.xz" -C "$TMP" --exclude='libclang*' \
        --exclude='libMLIR*' --exclude='liblldb*' --exclude='libflang*' \
        --exclude='libFortran*'
      rm "$TMP/$NAME.tar.xz"
    fi
    LLVM_DIR="$TMP/$NAME/lib/cmake/llvm"
  fi
fi

cd "$ROOT"
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DLLVM_DIR="$LLVM_DIR"
cmake --build build --config Release --parallel "$(nproc)"
rm -rf "dist/$PLATFORM"
mkdir -p "dist/$PLATFORM/bin" "dist/$PLATFORM/lib"
cp build/alanc "dist/$PLATFORM/bin/alanc"
sh runtime/build.sh "$ZIG" "$TARGET" "dist/$PLATFORM/lib"
echo "built dist/$PLATFORM"
