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
  # grep matches per line, so refuse a multi-line value outright first.
  case "$v" in
    *'
'*) die "unexpected version (contains a newline)" ;;
  esac
  printf '%s' "$v" | grep -Eq '^v[0-9]+(\.[0-9]+){2}$' || die "unexpected version '$v' (want vX.Y.Z)"
  echo "$v"
}

# True when $1 is owned by the current user (test -O is not POSIX).
owned_by_me() { [ -n "$(find "$1" -prune -user "$(id -u)" 2>/dev/null)" ]; }

# True when neither group nor others can write to $1 (mode string positions 6 and 9).
not_shared_writable() {
  # shellcheck disable=SC2012 # ls -ld is the portable way to read the mode string
  mode=$(ls -ld "$1" | cut -c1-10)
  [ "$(printf '%s' "$mode" | cut -c6)" != w ] && [ "$(printf '%s' "$mode" | cut -c9)" != w ]
}

# Creates $1 private (0700) if missing, then requires it to be a real directory (not a
# symlink) that only this user can write to. Anything else could have been planted.
ensure_private_dir() {
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then mkdir -m 700 "$1" || die "cannot create $1"; fi
  [ ! -L "$1" ] || die "$1 is a symlink: refusing to use it (remove it and retry)"
  [ -d "$1" ] || die "$1 is not a directory (remove it and retry)"
  owned_by_me "$1" || die "$1 is not owned by you: refusing to use it"
  not_shared_writable "$1" || die "$1 is group- or world-writable: refusing to use it (chmod go-w it and retry)"
}

# The cache path must be free for a regular file: a symlink or directory there could redirect the move.
check_dest() {
  [ ! -L "$1" ] || die "$1 is a symlink: refusing to replace it (remove it and retry)"
  [ ! -d "$1" ] || die "$1 is a directory: refusing to replace it (remove it and retry)"
}

# A cached binary is trusted only if it is a regular, executable, non-symlink file
# that only this user owns and can write.
is_cached() { [ -f "$1" ] && [ ! -L "$1" ] && [ -x "$1" ] && owned_by_me "$1" && not_shared_writable "$1"; }

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
  stage=$(mktemp -d "$dir/.lightpath.XXXXXX") || die "cannot write to $dir"
  cp "$tmp/x/lightpath" "$stage/lightpath" || die "cannot write to $dir"
  chmod 755 "$stage/lightpath"
  check_dest "$4"
  mv -f "$stage/lightpath" "$4" || die "cannot cache to $dir"

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
  umask 077
  mkdir -p "$cache_base" || die "cannot create $cache_base"
  root="$cache_base/lightpath"
  vdir="$root/$version"
  bin="$vdir/lightpath"
  ensure_private_dir "$root"
  ensure_private_dir "$vdir"

  if ! is_cached "$bin"; then
    check_dest "$bin"
    download "$version" "$os" "$arch" "$bin"
  fi

  say "Running lightpath $version · Ctrl-C to stop"
  exec "$bin" --no-open </dev/null
}

main
