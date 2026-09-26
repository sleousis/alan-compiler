#!/bin/sh
# Builds alanc and libalanrt.a for this Mac into dist/<platform>/.
# arm64 uses the official LLVM release package, x86_64 uses Homebrew LLVM.
# Bison and flex come from Homebrew. The runtime is built with zig
# (ALAN_ZIG, or zig on the PATH).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tools/versions.env"
ZIG="${ALAN_ZIG:-zig}"
LLVM_MAJOR="${LLVM_VERSION%%.*}"

brew install bison flex
BREW_PREFIX="$(brew --prefix)"
case "$(uname -m)" in
  arm64)
    PLATFORM=macos-arm64; TARGET=aarch64-macos
    if [ -z "${LLVM_DIR:-}" ]; then
      NAME="LLVM-$LLVM_VERSION-macOS-ARM64"
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
    ;;
  x86_64)
    PLATFORM=macos-x64; TARGET=x86_64-macos
    if [ -z "${LLVM_DIR:-}" ]; then
      if brew install "llvm@$LLVM_MAJOR"; then
        LLVM_PREFIX="$(brew --prefix "llvm@$LLVM_MAJOR")"
      else
        brew install llvm
        LLVM_PREFIX="$(brew --prefix llvm)"
        case "$("$LLVM_PREFIX/bin/llvm-config" --version)" in
          "$LLVM_MAJOR".*) ;;
          *) echo "Homebrew llvm is not version $LLVM_MAJOR" >&2; exit 1 ;;
        esac
      fi
      LLVM_DIR="$LLVM_PREFIX/lib/cmake/llvm"
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
otool -L build/alanc
if otool -L build/alanc | tail -n +2 | grep -v -e '^[[:space:]]*/usr/lib/' -e '^[[:space:]]*/System/'; then
  echo "alanc links libraries outside the system" >&2
  exit 1
fi

rm -rf "dist/$PLATFORM"
mkdir -p "dist/$PLATFORM/bin" "dist/$PLATFORM/lib"
cp build/alanc "dist/$PLATFORM/bin/alanc"
sh runtime/build.sh "$ZIG" "$TARGET" "dist/$PLATFORM/lib"
echo "built dist/$PLATFORM"
