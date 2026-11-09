#!/bin/sh
# Run Lightpath without installing it: curl -fsSL https://lightpath.blackpaw.studio/run | sh
#
# Downloads the latest release once, verifies its sha256, caches it under
# ${XDG_CACHE_HOME:-$HOME/.cache}/lightpath/<version>/ and runs it (Ctrl-C to stop).
#
# Environment:
#   LIGHTPATH_RELEASES_URL  releases page (default: GitHub)
#   LIGHTPATH_VERSION       pin a release tag such as v1.2.3 (default: latest)
set -eu

RELEASES_URL="${LIGHTPATH_RELEASES_URL:-https://github.com/blackpaw-studio/lightpath/releases}"

die() { printf 'lightpath-run: %s\n' "$*" >&2; exit 1; }
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

# Prints the URL that .../releases/latest redirects to (ends in /tag/<version>).
latest_url() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSLI -o /dev/null -w '%{url_effective}' "$RELEASES_URL/latest" || die "could not look up the latest version"
  elif command -v wget >/dev/null 2>&1; then
    wget -S --spider "$RELEASES_URL/latest" 2>&1 | tr -d '\r' | awk 'tolower($1) == "location:" { u = $2 } END { print u }'
  else
    die "need curl or wget"
  fi
}

resolve_version() {
  v="${LIGHTPATH_VERSION:-}"
  if [ -z "$v" ]; then
    url=$(latest_url)
    v="${url##*/}"
  fi
  # The tag becomes a path component and a URL segment: accept nothing but vX.Y.Z.
  printf '%s' "$v" | grep -Eq '^v[0-9]+(\.[0-9]+){2}$' || die "unexpected version '$v' (want vX.Y.Z)"
  echo "$v"
}

# A cached binary is trusted only if it is a regular, executable, non-symlink file.
is_cached() { [ -f "$1" ] && [ ! -L "$1" ] && [ -x "$1" ]; }

download() { # download <version> <os> <arch> <dest binary>
  name="lightpath_${2}_${3}.tar.gz"
  tmp=$(mktemp -d)
  stage=""
  trap 'rm -rf "$tmp" "$stage"' EXIT INT TERM

  say "Downloading lightpath $1 ($2/$3)"
  fetch "$RELEASES_URL/download/$1/$name" "$tmp/$name"
  fetch "$RELEASES_URL/download/$1/checksums.txt" "$tmp/checksums.txt"

  want=$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1; exit }' "$tmp/checksums.txt")
  [ -n "$want" ] || die "no checksum entry for $name"
  got=$(sha256_of "$tmp/$name")
  [ "$want" = "$got" ] || die "checksum mismatch for $name (expected $want, got $got)"

  mkdir "$tmp/x"
  tar -xzf "$tmp/$name" -C "$tmp/x" lightpath || die "could not extract $name"

  dir=$(dirname "$4")
  mkdir -p "$dir" || die "cannot create $dir"
  stage=$(mktemp -d "$dir/.lightpath.XXXXXX") || die "cannot write to $dir"
  cp "$tmp/x/lightpath" "$stage/lightpath" || die "cannot write to $dir"
  chmod 755 "$stage/lightpath"
  mv -f "$stage/lightpath" "$4" || die "cannot cache to $dir" # rename: replaces a symlink, never follows it

  rm -rf "$tmp" "$stage"
  trap - EXIT INT TERM
}

main() {
  os=$(detect_os)
  arch=$(detect_arch)
  version=$(resolve_version)

  if [ -n "${XDG_CACHE_HOME:-}" ]; then cache_base="$XDG_CACHE_HOME"
  elif [ -n "${HOME:-}" ]; then cache_base="$HOME/.cache"
  else die "set HOME or XDG_CACHE_HOME"
  fi
  bin="$cache_base/lightpath/$version/lightpath"

  is_cached "$bin" || download "$version" "$os" "$arch" "$bin"

  say "Running lightpath $version · Ctrl-C to stop"
  exec "$bin" --no-open </dev/null
}

main
