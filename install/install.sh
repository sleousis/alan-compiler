#!/bin/sh
# Installs the Alan compiler to ~/.local/share/alan and links alanc into ~/.local/bin.
# ALAN_VERSION picks a release (default: the latest). ALAN_BASE_URL points at
# another copy of the releases, which the CI tests use.
set -eu
BASE="${ALAN_BASE_URL:-https://github.com/sleousis/alan-compiler/releases}"
VER="${ALAN_VERSION:-}"
if [ -z "$VER" ]; then
  VER=$(curl -fsSL https://api.github.com/repos/sleousis/alan-compiler/releases/latest \
        | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)
fi
[ -n "$VER" ] || { echo "Could not find the latest Alan release." >&2; exit 1; }
case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=macos ;;
  *) echo "Unsupported system $(uname -s). Use install.ps1 on Windows." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "Unsupported CPU $(uname -m)." >&2; exit 1 ;;
esac
# A shell running under Rosetta reports x86_64 on an Apple silicon Mac.
if [ "$OS" = macos ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  ARCH=arm64
fi
NAME="alan-$VER-$OS-$ARCH.tar.gz"
if command -v sha256sum >/dev/null; then SHA="sha256sum"; else SHA="shasum -a 256"; fi
TMP=$(mktemp -d); trap 'rm -rf "$TMP" "$HOME/.local/share/alan.new"' EXIT
CODE=$(curl -fsSL -w '%{http_code}' "$BASE/download/$VER/$NAME" -o "$TMP/$NAME") || {
  if [ "$CODE" = 404 ]; then
    echo "Alan $VER has no download for $OS-$ARCH." >&2
  else
    echo "Could not download $NAME. Check your connection." >&2
  fi
  exit 1
}
curl -fsSL "$BASE/download/$VER/SHA256SUMS" -o "$TMP/SHA256SUMS" \
  || { echo "Could not download the SHA256SUMS of Alan $VER." >&2; exit 1; }
( cd "$TMP" && grep "[ *]$NAME\$" SHA256SUMS | $SHA -c - ) >/dev/null \
  || { echo "Checksum mismatch for $NAME. Nothing was installed." >&2; exit 1; }
DEST="$HOME/.local/share/alan"
rm -rf "$DEST.new"; mkdir -p "$DEST.new"
tar -xzf "$TMP/$NAME" -C "$DEST.new" --strip-components=1
[ "$OS" = macos ] && xattr -dr com.apple.quarantine "$DEST.new" 2>/dev/null || true
rm -rf "$DEST"; mv "$DEST.new" "$DEST"
mkdir -p "$HOME/.local/bin"
ln -sf "$DEST/bin/alanc" "$HOME/.local/bin/alanc"
echo "Installed Alan $VER. Run: alanc run hello.alan"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "Add $HOME/.local/bin to your PATH first, for example in your shell profile:"
     echo "  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac
echo "To uninstall: rm -rf \"$DEST\" \"$HOME/.local/bin/alanc\""
