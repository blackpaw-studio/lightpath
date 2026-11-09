#!/bin/sh
# Tests ui/public/run.sh using file:// release fixtures, a stubbed uname and a stubbed curl.
set -u

ROOT=$(cd "$(dirname "$0")" && pwd)
RUN="$ROOT/ui/public/run.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

fails=0
runs=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

REAL_CURL=$(command -v curl) || { echo "run_test.sh needs curl"; exit 1; }

# Stubs on PATH. uname: STUB_S / STUB_M. curl: logs every call to $STUB_LOG, answers the
# "latest release" HEAD request with $STUB_LATEST_URL, and otherwise delegates to real curl.
mkdir -p "$TMP/stub"
cat >"$TMP/stub/uname" <<'STUB'
#!/bin/sh
case "$1" in
  -s) echo "$STUB_S" ;;
  -m) echo "$STUB_M" ;;
  *) echo "$STUB_S" ;;
esac
STUB
cat >"$TMP/stub/curl" <<STUB
#!/bin/sh
echo "\$*" >>"\$STUB_LOG"
case " \$* " in
  *" -I "* | *"fsSLI"*) printf '%s' "\$STUB_LATEST_URL"; exit 0 ;;
esac
exec "$REAL_CURL" "\$@"
STUB
chmod +x "$TMP/stub/uname" "$TMP/stub/curl"

# Fake release for one version: one archive per target; each binary prints its name and arguments.
make_release() { # make_release <version>
  d="$TMP/release/download/$1"
  mkdir -p "$d"
  : >"$d/checksums.txt"
  for os in darwin linux; do
    for arch in amd64 arm64; do
      b="$TMP/build/$1/$os-$arch"
      mkdir -p "$b"
      printf '#!/bin/sh\necho "lightpath-%s-%s-%s $*"\n' "$os" "$arch" "$1" >"$b/lightpath"
      chmod +x "$b/lightpath"
      name="lightpath_${os}_${arch}.tar.gz"
      tar -czf "$d/$name" -C "$b" lightpath
      printf '%s  %s\n' "$(sha256 "$d/$name")" "$name" >>"$d/checksums.txt"
    done
  done
}
make_release v1.2.3
make_release v1.2.4
rel="file://$TMP/release"

# run_run <uname -s> <uname -m> <releases url> [version]: sets $out, $code, $cache, $log.
run_run() {
  runs=$((runs + 1))
  cache="$TMP/cache-${CACHE_ID:-$runs}"
  log="$TMP/curl-$runs.log"
  : >"$log"
  out=$(STUB_S="$1" STUB_M="$2" PATH="$TMP/stub:$PATH" HOME="$TMP/home" XDG_CACHE_HOME="$cache" \
    STUB_LOG="$log" STUB_LATEST_URL="${STUB_LATEST_URL:-https://github.com/x/lightpath/releases/tag/v1.2.3}" \
    LIGHTPATH_RELEASES_URL="$3" LIGHTPATH_VERSION="${4:-}" sh "$RUN" 2>&1 </dev/null)
  code=$?
}

# First run: downloads, verifies, caches and execs the binary with --no-open.
run_run Linux x86_64 "$rel" v1.2.3
if [ "$code" -eq 0 ] && printf '%s' "$out" | grep -q 'lightpath-linux-amd64-v1.2.3 --no-open' \
  && [ -x "$cache/lightpath/v1.2.3/lightpath" ] && [ ! -L "$cache/lightpath/v1.2.3/lightpath" ]; then
  pass "first run downloads, caches and runs with --no-open"
else
  fail "first run downloads, caches and runs with --no-open (code=$code) $out"
fi

# The banner names what runs and how to stop it, before the agent's own output.
if [ "$(printf '%s\n' "$out" | grep -B1 '^lightpath-linux-amd64' | head -n 1)" = 'Running lightpath v1.2.3 · Ctrl-C to stop' ]; then
  pass "prints a one-line banner before exec"
else
  fail "prints a one-line banner before exec: $out"
fi

# Nothing but the cached binary is left behind.
if [ -z "$(find "$cache" -name '.lightpath.*')" ]; then pass "leaves no staging directories"
else fail "leaves no staging directories"; fi

# Second run (version resolved via the stubbed HEAD request) reuses the cache: no archive fetch.
CACHE_ID=reuse
run_run Darwin arm64 "$rel" v1.2.3
first_cache=$cache
run_run Darwin arm64 "$rel"
if [ "$code" -eq 0 ] && [ "$cache" = "$first_cache" ] && printf '%s' "$out" | grep -q 'lightpath-darwin-arm64-v1.2.3 --no-open' \
  && ! grep -q 'tar.gz' "$log" && grep -q 'fsSLI' "$log"; then
  pass "second run resolves latest and reuses the cached binary without downloading"
else
  fail "second run reuses the cache (code=$code) $out :: $(cat "$log")"
fi

# A new version gets its own cache directory and download.
STUB_LATEST_URL="https://github.com/x/lightpath/releases/tag/v1.2.4"; run_run Darwin arm64 "$rel"; unset STUB_LATEST_URL
if [ "$code" -eq 0 ] && printf '%s' "$out" | grep -q 'lightpath-darwin-arm64-v1.2.4' \
  && [ -x "$cache/lightpath/v1.2.3/lightpath" ] && [ -x "$cache/lightpath/v1.2.4/lightpath" ]; then
  pass "a newer release is fetched into its own cache directory"
else
  fail "a newer release is fetched into its own cache directory (code=$code) $out"
fi
unset CACHE_ID

# Checksum mismatch must fail and cache nothing.
bad="$TMP/bad"
cp -R "$TMP/release" "$bad"
printf 'tampered' >>"$bad/download/v1.2.3/lightpath_linux_amd64.tar.gz"
run_run Linux x86_64 "file://$bad" v1.2.3
if [ "$code" -ne 0 ] && printf '%s' "$out" | grep -qi checksum && [ ! -e "$cache/lightpath/v1.2.3" ] \
  && ! printf '%s' "$out" | grep -q 'lightpath-linux'; then
  pass "checksum mismatch fails and caches nothing"
else
  fail "checksum mismatch fails and caches nothing (code=$code) $out"
fi

# Missing checksum entry fails too.
nosum="$TMP/nosum"
cp -R "$TMP/release" "$nosum"
: >"$nosum/download/v1.2.3/checksums.txt"
run_run Linux x86_64 "file://$nosum" v1.2.3
if [ "$code" -ne 0 ] && [ ! -e "$cache/lightpath/v1.2.3" ]; then pass "missing checksum entry fails"
else fail "missing checksum entry fails (code=$code) $out"; fi

# Unsupported arch / OS.
run_run Linux riscv64 "$rel" v1.2.3
if [ "$code" -ne 0 ] && printf '%s' "$out" | grep -qi unsupported; then pass "unsupported arch fails"
else fail "unsupported arch fails (code=$code) $out"; fi
run_run FreeBSD amd64 "$rel" v1.2.3
if [ "$code" -ne 0 ] && printf '%s' "$out" | grep -qi unsupported; then pass "unsupported OS fails"
else fail "unsupported OS fails (code=$code) $out"; fi

# Malformed version tags are rejected before they can reach a path or URL.
for v in 'v1.2.3-evil' 'latest' 'v1/../../x' '../x' 'v1.2' ''; do
  if [ -z "$v" ]; then
    STUB_LATEST_URL="https://github.com/x/lightpath/releases/tag/"; run_run Linux x86_64 "$rel"; unset STUB_LATEST_URL
  else
    run_run Linux x86_64 "$rel" "$v"
  fi
  if [ "$code" -ne 0 ] && printf '%s' "$out" | grep -qi 'version' && ! find "$cache" -type f 2>/dev/null | grep -q .; then
    pass "rejects malformed version '$v'"
  else
    fail "rejects malformed version '$v' (code=$code) $out"
  fi
done
STUB_LATEST_URL="https://github.com/x/lightpath/releases/tag/nightly"; run_run Linux x86_64 "$rel"; unset STUB_LATEST_URL
if [ "$code" -ne 0 ] && printf '%s' "$out" | grep -qi 'version'; then pass "rejects a malformed resolved tag"
else fail "rejects a malformed resolved tag (code=$code) $out"; fi

# A pre-planted symlink at the cache path is never executed: it is replaced by a verified download.
CACHE_ID=symlink
cache="$TMP/cache-symlink"
mkdir -p "$cache/lightpath/v1.2.3"
printf '#!/bin/sh\ntouch "%s/pwned"\n' "$TMP" >"$TMP/evil"
chmod +x "$TMP/evil"
ln -s "$TMP/evil" "$cache/lightpath/v1.2.3/lightpath"
run_run Linux x86_64 "$rel" v1.2.3
if [ "$code" -eq 0 ] && [ ! -e "$TMP/pwned" ] && printf '%s' "$out" | grep -q 'lightpath-linux-amd64-v1.2.3' \
  && [ ! -L "$cache/lightpath/v1.2.3/lightpath" ] && grep -q '#!/bin/sh' "$TMP/evil"; then
  pass "does not trust a symlink at the cache path"
else
  fail "does not trust a symlink at the cache path (code=$code) $out"
fi
unset CACHE_ID

# A non-executable cached file is re-downloaded rather than exec'd.
CACHE_ID=noexec
cache="$TMP/cache-noexec"
mkdir -p "$cache/lightpath/v1.2.3"
printf 'junk' >"$cache/lightpath/v1.2.3/lightpath"
chmod 644 "$cache/lightpath/v1.2.3/lightpath"
run_run Linux x86_64 "$rel" v1.2.3
if [ "$code" -eq 0 ] && printf '%s' "$out" | grep -q 'lightpath-linux-amd64-v1.2.3'; then pass "re-downloads a non-executable cache entry"
else fail "re-downloads a non-executable cache entry (code=$code) $out"; fi
unset CACHE_ID

# Falls back to ~/.cache when XDG_CACHE_HOME is unset.
mkdir -p "$TMP/home"
out=$(STUB_S=Linux STUB_M=x86_64 PATH="$TMP/stub:$PATH" HOME="$TMP/home" STUB_LOG="$TMP/curl-home.log" \
  LIGHTPATH_RELEASES_URL="$rel" LIGHTPATH_VERSION=v1.2.3 env -u XDG_CACHE_HOME sh "$RUN" 2>&1 </dev/null)
code=$?
if [ "$code" -eq 0 ] && [ -x "$TMP/home/.cache/lightpath/v1.2.3/lightpath" ]; then pass "defaults the cache to ~/.cache"
else fail "defaults the cache to ~/.cache (code=$code) $out"; fi

if [ "$fails" -ne 0 ]; then printf '%s test(s) failed\n' "$fails"; exit 1; fi
echo "all run tests passed"
