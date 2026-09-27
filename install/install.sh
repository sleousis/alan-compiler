#!/bin/sh
# Installs the Alan compiler to ~/.local/share/alan and links alanc into ~/.local/bin.
# ALAN_VERSION picks a release (default: the latest). ALAN_BASE_URL points at
# another copy of the releases, which the CI tests use.
# Everything runs from main at the last line, so a download cut short by
# "curl | sh" runs nothing at all.
set -eu

fail() { echo "$1" >&2; exit 1; }

# Removes the download and the new folder. After an interrupted swap it puts
# the old install back.
cleanup() {
  rm -rf "$TMP" "$DEST.new"
  if [ -d "$DEST.old" ]; then
    if [ -e "$DEST" ]; then rm -rf "$DEST.old"; else mv "$DEST.old" "$DEST"; fi
  fi
}

main() {
  [ -n "${HOME:-}" ] || fail "HOME is not set."
  BASE="${ALAN_BASE_URL:-https://github.com/sleousis/alan-compiler/releases}"
  VER="${ALAN_VERSION:-}"
  if [ -z "$VER" ]; then
    VER=$(curl -fsSL https://api.github.com/repos/sleousis/alan-compiler/releases/latest \
          | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)
  fi
  [ -n "$VER" ] || fail "Could not find the latest Alan release."
  case "$(uname -s)" in
    Linux) OS=linux ;;
    Darwin) OS=macos ;;
    *) fail "Unsupported system $(uname -s). Use install.ps1 on Windows." ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) fail "Unsupported CPU $(uname -m)." ;;
  esac
  # A shell running under Rosetta reports x86_64 on an Apple silicon Mac.
  if [ "$OS" = macos ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    ARCH=arm64
  fi
  NAME="alan-$VER-$OS-$ARCH.tar.gz"
  if command -v sha256sum >/dev/null; then SHA="sha256sum"; else SHA="shasum -a 256"; fi
  DEST="$HOME/.local/share/alan"
  TMP=$(mktemp -d)
  trap cleanup EXIT
  trap 'exit 1' INT TERM HUP

  CODE=$(curl -fsSL -w '%{http_code}' "$BASE/download/$VER/$NAME" -o "$TMP/$NAME") || {
    [ "$CODE" = 404 ] && fail "Alan $VER has no download for $OS-$ARCH."
    fail "Could not download $NAME. Check your connection."
  }
  curl -fsSL "$BASE/download/$VER/SHA256SUMS" -o "$TMP/SHA256SUMS" \
    || fail "Could not download the SHA256SUMS of Alan $VER."
  # the line whose file name is exactly NAME (sha256sum marks binary mode with *)
  WANT=$(awk -v n="$NAME" '$2 == n || $2 == "*" n { print $1; exit }' "$TMP/SHA256SUMS")
  [ -n "$WANT" ] || fail "SHA256SUMS of Alan $VER has no line for $NAME. Nothing was installed."
  GOT=$($SHA "$TMP/$NAME" | awk '{ print $1 }')
  [ "$GOT" = "$WANT" ] || fail "Checksum mismatch for $NAME. Nothing was installed."

  rm -rf "$DEST.new" "$DEST.old"; mkdir -p "$DEST.new"
  tar -xzf "$TMP/$NAME" -C "$DEST.new" --strip-components=1
  [ -x "$DEST.new/bin/alanc" ] || fail "$NAME does not hold alan/bin/alanc. Nothing was installed."
  [ "$OS" = macos ] && xattr -dr com.apple.quarantine "$DEST.new" 2>/dev/null || true
  # The old install moves aside first and comes back if the new one cannot
  # take its place.
  if [ -e "$DEST" ]; then
    mv "$DEST" "$DEST.old" || fail "Could not move the old $DEST aside. Nothing was installed."
  fi
  if ! mv "$DEST.new" "$DEST"; then
    [ -d "$DEST.old" ] && mv "$DEST.old" "$DEST"
    fail "Could not move the new install into $DEST. The old one is still there."
  fi
  rm -rf "$DEST.old"
  mkdir -p "$HOME/.local/bin"
  ln -sf "$DEST/bin/alanc" "$HOME/.local/bin/alanc"
  echo "Installed Alan $VER. Run: alanc run hello.alan"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) echo "Add $HOME/.local/bin to your PATH first, for example in your shell profile:"
       echo "  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac
  echo "To uninstall: rm -rf \"$DEST\" \"$HOME/.local/bin/alanc\""
}

main "$@"
