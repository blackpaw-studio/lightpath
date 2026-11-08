#!/bin/sh
# Lightpath installer: curl -fsSL https://lightpath.blackpaw.studio/install.sh | sh
#
# Environment:
#   LIGHTPATH_BASE_URL      release download base (default: GitHub latest release)
#   LIGHTPATH_INSTALL_DIR   install directory override
#   LIGHTPATH_FORCE_USER_DIR=1  skip /usr/local/bin, use ~/.local/bin
set -eu

BASE_URL="${LIGHTPATH_BASE_URL:-https://github.com/blackpaw-studio/lightpath/releases/latest/download}"

die() { printf 'lightpath-install: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

detect_os() {
  case "$(uname -s)" in
    Darwin) echo darwin ;;
    Linux) echo linux ;;
    *) die "unsupported OS: $(uname -s) (darwin and linux only)" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) echo amd64 ;;
    arm64 | aarch64) echo arm64 ;;
    *) die "unsupported architecture: $(uname -m) (amd64 and arm64 only)" ;;
  esac
}

fetch() { # fetch <url> <dest>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2" || die "download failed: $1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1" || die "download failed: $1"
  else
    die "need curl or wget"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    die "need sha256sum or shasum to verify the download"
  fi
}

pick_install_dir() {
  sys="${LIGHTPATH_SYSTEM_DIR:-/usr/local/bin}" # override exists for tests
  if [ -n "${LIGHTPATH_INSTALL_DIR:-}" ]; then
    echo "$LIGHTPATH_INSTALL_DIR"
  elif [ "${LIGHTPATH_FORCE_USER_DIR:-}" != 1 ] && [ -d "$sys" ] && [ -w "$sys" ]; then
    echo "$sys"
  else
    echo "$HOME/.local/bin"
  fi
}

main() {
  os=$(detect_os)
  arch=$(detect_arch)
  name="lightpath_${os}_${arch}.tar.gz"

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT INT TERM

  say "Downloading $name"
  fetch "$BASE_URL/$name" "$tmp/$name"
  fetch "$BASE_URL/checksums.txt" "$tmp/checksums.txt"

  want=$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1; exit }' "$tmp/checksums.txt")
  [ -n "$want" ] || die "no checksum entry for $name"
  got=$(sha256_of "$tmp/$name")
  [ "$want" = "$got" ] || die "checksum mismatch for $name (expected $want, got $got)"

  mkdir "$tmp/x"
  tar -xzf "$tmp/$name" -C "$tmp/x" lightpath || die "could not extract $name"

  dir=$(pick_install_dir)
  mkdir -p "$dir" || die "cannot create $dir"
  stage=$(mktemp -d "$dir/.lightpath.XXXXXX") || die "cannot write to $dir"
  trap 'rm -rf "$tmp" "$stage"' EXIT INT TERM
  cp "$tmp/x/lightpath" "$stage/lightpath" || die "cannot write to $dir"
  chmod 755 "$stage/lightpath"
  mv -f "$stage/lightpath" "$dir/lightpath" || die "cannot install to $dir"
  say "Installed $dir/lightpath"

  case ":$PATH:" in
    *":$dir:"*) ;;
    *) say "Add $dir to your PATH:  export PATH=\"$dir:\$PATH\"" ;;
  esac

  if ! command -v traceroute >/dev/null 2>&1; then
    say "Warning: traceroute not found on PATH. Lightpath needs it (Debian/Ubuntu: sudo apt install traceroute)."
  fi
  say "Run: lightpath"
}

main
