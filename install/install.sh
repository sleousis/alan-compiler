#!/bin/sh
# Installs the Alan compiler to ~/.local/share/alan and links alanc into ~/.local/bin.
# ALAN_VERSION picks a release (default: the newest compiler release, whose
# tag is v and a digit). ALAN_BASE_URL and ALAN_API_URL point at another
# copy of the releases and of their list, which the CI tests use.
# Everything runs from main at the last line, so a download cut short by
# "curl | sh" runs nothing at all.
set -eu

fail() { echo "$1" >&2; exit 1; }

# Puts the old install back after an interrupted swap, so the only working
# install is never deleted.
restore_old() {
  if [ ! -e "$DEST" ] && [ -d "$DEST.old" ]; then mv "$DEST.old" "$DEST" || true; fi
}

# Restores the old install first. Then removes the download, the new folder
# and an old install that is no longer needed.
cleanup() {
  restore_old
  rm -rf "$TMP" "$DEST.new" 2>/dev/null || true
  if [ -e "$DEST" ] && [ -d "$DEST.old" ]; then rm -rf "$DEST.old" 2>/dev/null || true; fi
}

# Prints the tag of the newest release that is not a draft or a prerelease
# and starts with v and a digit. GitHub lists the newest release first.
# Cutting the JSON at commas and brackets puts every key on its own line,
# whatever the layout. Quotes inside strings are escaped, so a release note
# cannot look like a key.
newest_compiler_tag() {
  curl -fsSL "$API/releases?per_page=100" | tr ',{}[]' '\n\n\n\n\n' | awk '
    /^[ \t]*"tag_name"[ \t]*:/ {
      t = $0; sub(/^[ \t]*"tag_name"[ \t]*:[ \t]*"/, "", t); sub(/".*/, "", t); ht = 1
    }
    /^[ \t]*"draft"[ \t]*:/ { d = ($0 ~ /true/); hd = 1 }
    /^[ \t]*"prerelease"[ \t]*:/ { p = ($0 ~ /true/); hp = 1 }
    ht && hd && hp {
      if (!d && !p && t ~ /^v[0-9]/) { print t; exit }
      ht = 0; hd = 0; hp = 0
    }'
}

main() {
  [ -n "${HOME:-}" ] || fail "HOME is not set."
  BASE="${ALAN_BASE_URL:-https://github.com/sleousis/alan-compiler/releases}"
  API="${ALAN_API_URL:-https://api.github.com/repos/sleousis/alan-compiler}"
  VER="${ALAN_VERSION:-}"
  # GitHub's "latest" release can be an extension release, so the list decides.
  [ -n "$VER" ] || VER=$(newest_compiler_tag) || VER=
  [ -n "$VER" ] || fail "Could not find an Alan compiler release. Check your connection, or set ALAN_VERSION to a tag such as v2.0.0."
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

  restore_old
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
  rm -rf "$DEST.old" 2>/dev/null || echo "Could not remove $DEST.old. Delete it later." >&2
  mkdir -p "$HOME/.local/bin"
  LINK="$HOME/.local/bin/alanc"
  # Only a link or nothing is replaced. A real file there belongs to the user.
  UNINSTALL="rm -rf \"$DEST\""
  if [ -L "$LINK" ] || [ ! -e "$LINK" ]; then
    ln -sf "$DEST/bin/alanc" "$LINK"
    UNINSTALL="$UNINSTALL \"$LINK\""
  else
    echo "Warning: $LINK is not a link, so it was left alone and may run another alanc." >&2
    echo "Remove it and run this installer again, or run $DEST/bin/alanc." >&2
  fi
  echo "Installed Alan $VER. Run: alanc run hello.alan"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) echo "Add $HOME/.local/bin to your PATH first, for example in your shell profile:"
       echo "  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac
  echo "To uninstall: $UNINSTALL"
}

main "$@"
