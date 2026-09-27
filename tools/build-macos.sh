#!/bin/sh
# Builds alanc and libalanrt.a for this Mac into dist/<platform>/.
# LLVM is built from the release sources for macOS 12 into $RUNNER_TEMP
# (or /tmp), unless LLVM_DIR points at another LLVM. No Homebrew library is
# linked. Bison, flex and ninja come from Homebrew as build tools only.
# The runtime is built with zig (ALAN_ZIG, or zig on the PATH).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tools/versions.env"
ZIG="${ALAN_ZIG:-zig}"
LLVM_MAJOR="${LLVM_VERSION%%.*}"
TMP="${RUNNER_TEMP:-/tmp}"
RELEASES="https://github.com/llvm/llvm-project/releases/download/llvmorg-$LLVM_VERSION"
export MACOSX_DEPLOYMENT_TARGET=12.0

# Builds the LLVM libraries alanc needs, without optional dependencies.
build_llvm_from_source() {
  prefix="$1"
  src="llvm-project-$LLVM_VERSION.src"
  brew install ninja
  curl -fsSL -o "$TMP/$src.tar.xz" "$RELEASES/$src.tar.xz"
  tar -xJf "$TMP/$src.tar.xz" -C "$TMP" "$src/llvm" "$src/cmake" "$src/third-party" "$src/libc"
  rm "$TMP/$src.tar.xz"
  cmake -G Ninja -S "$TMP/$src/llvm" -B "$TMP/llvm-build" \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$prefix" \
    -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0 \
    -DLLVM_TARGETS_TO_BUILD="X86;AArch64" -DLLVM_ENABLE_PROJECTS= \
    -DLLVM_BUILD_TOOLS=OFF -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF \
    -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_DOCS=OFF \
    -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_LIBXML2=OFF \
    -DLLVM_ENABLE_LIBEDIT=OFF -DLLVM_ENABLE_LIBPFM=OFF -DLLVM_ENABLE_Z3_SOLVER=OFF \
    -DLLVM_ENABLE_CURL=OFF -DLLVM_ENABLE_HTTPLIB=OFF -DLLVM_ENABLE_FFI=OFF
  cmake --build "$TMP/llvm-build" --target install
  rm -rf "$TMP/llvm-build" "$TMP/$src"
  # Written last, so a cut-off build is never taken for a complete one.
  touch "$prefix/complete"
}

brew install bison flex
BREW_PREFIX="$(brew --prefix)"
case "$(uname -m)" in
  arm64) PLATFORM=macos-arm64; TARGET=aarch64-macos ;;
  x86_64) PLATFORM=macos-x64; TARGET=x86_64-macos ;;
  *) echo "unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac
# The official macOS package and Homebrew's LLVM are built for newer macOS
# versions than 12 and link Homebrew's zstd, so build LLVM here instead.
if [ -z "${LLVM_DIR:-}" ]; then
  SOURCE_PREFIX="$TMP/llvm-$LLVM_VERSION-$(uname -m)-macos"
  if [ ! -f "$SOURCE_PREFIX/complete" ]; then
    echo "building LLVM $LLVM_VERSION from source into $SOURCE_PREFIX"
    rm -rf "$SOURCE_PREFIX"
    build_llvm_from_source "$SOURCE_PREFIX"
  fi
  LLVM_DIR="$SOURCE_PREFIX/lib/cmake/llvm"
fi

cd "$ROOT"
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DLLVM_DIR="$LLVM_DIR" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0 \
  -DBISON_EXECUTABLE="$BREW_PREFIX/opt/bison/bin/bison" \
  -DFLEX_EXECUTABLE="$BREW_PREFIX/opt/flex/bin/flex"
# Show the flags alanc compiles with, so the log shows -Werror and the
# -isystem LLVM includes.
grep -E '^C(XX)?_(FLAGS|INCLUDES)' build/CMakeFiles/alanc.dir/flags.make
BUILD_LOG="$TMP/alanc-build.log"
if ! cmake --build build --config Release --parallel "$(sysctl -n hw.ncpu)" >"$BUILD_LOG" 2>&1; then
  cat "$BUILD_LOG"
  exit 1
fi
cat "$BUILD_LOG"

# Every input the linker used must be built for macOS 12 or older. Apple's
# linker says "built for newer", lld says "newer than target minimum".
if grep -i -e 'newer than target minimum' -e 'built for newer' "$BUILD_LOG"; then
  echo "the linker reports inputs built for a newer macOS than 12.0 (listed above)" >&2
  exit 1
fi

# alanc must say it runs on macOS 12.0.
echo "otool -l build/alanc (LC_BUILD_VERSION):"
otool -l build/alanc | grep -A 4 LC_BUILD_VERSION
MINOS="$(otool -l build/alanc | awk '/cmd LC_BUILD_VERSION/ {b = 1} b && $1 == "minos" {print $2; exit}')"
if [ "$MINOS" != "12.0" ]; then
  echo "alanc has minos '$MINOS' in LC_BUILD_VERSION, expected 12.0" >&2
  exit 1
fi

# alanc must only depend on libraries that every Mac has.
echo "otool -L build/alanc:"
otool -L build/alanc
if otool -L build/alanc | tail -n +2 | grep -v -e '^[[:space:]]*/usr/lib/' -e '^[[:space:]]*/System/'; then
  echo "alanc links libraries outside the system (listed above)" >&2
  exit 1
fi

rm -rf "dist/$PLATFORM"
mkdir -p "dist/$PLATFORM/bin" "dist/$PLATFORM/lib"
cp build/alanc "dist/$PLATFORM/bin/alanc"
sh runtime/build.sh "$ZIG" "$TARGET" "dist/$PLATFORM/lib"
# The runtime is linked into every Alan program, so it must not need zlib
# or zstd either.
if nm -u "dist/$PLATFORM/lib/libalanrt.a" | grep -i -e zstd -e '_inflate' -e '_deflate' -e '_compress' -e '_uncompress'; then
  echo "libalanrt.a needs a compression library (listed above)" >&2
  exit 1
fi
echo "built dist/$PLATFORM"
