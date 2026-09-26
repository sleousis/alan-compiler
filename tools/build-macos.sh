#!/bin/sh
# Builds alanc and libalanrt.a for this Mac into dist/<platform>/.
# arm64 uses the official LLVM release package. x86_64 uses Homebrew LLVM
# when Homebrew has the right version, else builds LLVM from the release
# sources into $RUNNER_TEMP (or /tmp). Bison and flex come from Homebrew.
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
  tar -xJf "$TMP/$src.tar.xz" -C "$TMP" "$src/llvm" "$src/cmake" "$src/third-party"
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
}

brew install bison flex
BREW_PREFIX="$(brew --prefix)"
case "$(uname -m)" in
  arm64)
    PLATFORM=macos-arm64; TARGET=aarch64-macos
    if [ -z "${LLVM_DIR:-}" ]; then
      NAME="LLVM-$LLVM_VERSION-macOS-ARM64"
      if [ ! -d "$TMP/$NAME" ]; then
        curl -fsSL -o "$TMP/$NAME.tar.xz" "$RELEASES/$NAME.tar.xz"
        # Clang, MLIR, LLDB and Flang libraries are not needed.
        tar -xJf "$TMP/$NAME.tar.xz" -C "$TMP" --exclude='*/lib/libclang*' \
          --exclude='*/lib/libMLIR*' --exclude='*/lib/liblldb*' \
          --exclude='*/lib/libflang*' --exclude='*/lib/libFortran*'
        rm "$TMP/$NAME.tar.xz"
      fi
      LLVM_DIR="$TMP/$NAME/lib/cmake/llvm"
    fi
    ;;
  x86_64)
    PLATFORM=macos-x64; TARGET=x86_64-macos
    if [ -z "${LLVM_DIR:-}" ]; then
      SOURCE_PREFIX="$TMP/llvm-$LLVM_VERSION-x86_64-macos"
      if [ -d "$SOURCE_PREFIX/lib/cmake/llvm" ]; then
        LLVM_DIR="$SOURCE_PREFIX/lib/cmake/llvm"
      elif brew info "llvm@$LLVM_MAJOR" >/dev/null 2>&1; then
        brew install "llvm@$LLVM_MAJOR"
        LLVM_DIR="$(brew --prefix "llvm@$LLVM_MAJOR")/lib/cmake/llvm"
      elif brew info --json=v1 llvm | grep -q "\"stable\":\"$LLVM_MAJOR\\."; then
        brew install llvm
        LLVM_DIR="$(brew --prefix llvm)/lib/cmake/llvm"
      else
        echo "Homebrew has no LLVM $LLVM_MAJOR, building LLVM $LLVM_VERSION from source"
        build_llvm_from_source "$SOURCE_PREFIX"
        LLVM_DIR="$SOURCE_PREFIX/lib/cmake/llvm"
      fi
    fi
    ;;
  *) echo "unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac

cd "$ROOT"
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DLLVM_DIR="$LLVM_DIR" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0 \
  -DBISON_EXECUTABLE="$BREW_PREFIX/opt/bison/bin/bison" \
  -DFLEX_EXECUTABLE="$BREW_PREFIX/opt/flex/bin/flex"
cmake --build build --config Release --parallel "$(sysctl -n hw.ncpu)"

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
echo "built dist/$PLATFORM"
