#!/bin/sh
# Tests ui/public/install.sh using file:// release fixtures and a stubbed uname.
set -u

ROOT=$(cd "$(dirname "$0")" && pwd)
INSTALL="$ROOT/ui/public/install.sh"
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

# Stub uname on PATH: STUB_S / STUB_M give -s / -m output.
mkdir -p "$TMP/stub"
cat >"$TMP/stub/uname" <<'STUB'
#!/bin/sh
case "$1" in
  -s) echo "$STUB_S" ;;
  -m) echo "$STUB_M" ;;
  *) echo "$STUB_S" ;;
esac
STUB
chmod +x "$TMP/stub/uname"

# Fake release: one archive per target; each binary prints its own name.
rel="$TMP/release"
mkdir -p "$rel"
: >"$rel/checksums.txt"
for os in darwin linux; do
  for arch in amd64 arm64; do
    d="$TMP/build/$os-$arch"
    mkdir -p "$d"
    printf '#!/bin/sh\necho "lightpath-%s-%s"\n' "$os" "$arch" >"$d/lightpath"
    chmod +x "$d/lightpath"
    name="lightpath_${os}_${arch}.tar.gz"
    tar -czf "$rel/$name" -C "$d" lightpath
    printf '%s  %s\n' "$(sha256 "$rel/$name")" "$name" >>"$rel/checksums.txt"
  done
done

# run_install <uname -s> <uname -m> <base url> [dir]: sets $out, $code, $dest.
run_install() {
  runs=$((runs + 1))
  dest="${4:-$TMP/dest-$runs}"
  mkdir -p "$dest"
  out=$(STUB_S="$1" STUB_M="$2" PATH="$TMP/stub:$PATH" HOME="$TMP/home" \
    LIGHTPATH_BASE_URL="$3" LIGHTPATH_INSTALL_DIR="$dest" sh "$INSTALL" 2>&1)
  code=$?
}

check_mapping() {
  run_install "$1" "$2" "file://$rel"
  if [ "$code" -eq 0 ] && [ "$("$dest/lightpath" 2>/dev/null)" = "lightpath-$3-$4" ]; then
    pass "maps $1/$2 -> $3/$4"
  else
    fail "maps $1/$2 -> $3/$4 (code=$code) $out"
  fi
}

check_mapping Darwin arm64 darwin arm64
check_mapping Darwin x86_64 darwin amd64
check_mapping Linux aarch64 linux arm64
check_mapping Linux x86_64 linux amd64

# Checksum mismatch must fail and install nothing.
bad="$TMP/bad"
cp -R "$rel" "$bad"
printf 'tampered' >>"$bad/lightpath_linux_amd64.tar.gz"
run_install Linux x86_64 "file://$bad"
if [ "$code" -ne 0 ] && [ ! -e "$dest/lightpath" ] && printf '%s' "$out" | grep -qi checksum; then
  pass "checksum mismatch fails"
else
  fail "checksum mismatch fails (code=$code) $out"
fi

# Missing checksum entry must fail too.
nosum="$TMP/nosum"
cp -R "$rel" "$nosum"
: >"$nosum/checksums.txt"
run_install Linux x86_64 "file://$nosum"
if [ "$code" -ne 0 ] && [ ! -e "$dest/lightpath" ]; then pass "missing checksum entry fails"
else fail "missing checksum entry fails (code=$code) $out"; fi

# Unsupported arch / OS.
run_install Linux riscv64 "file://$rel"
if [ "$code" -ne 0 ] && printf '%s' "$out" | grep -qi unsupported; then pass "unsupported arch fails"
else fail "unsupported arch fails (code=$code) $out"; fi
run_install FreeBSD amd64 "file://$rel"
if [ "$code" -ne 0 ] && printf '%s' "$out" | grep -qi unsupported; then pass "unsupported OS fails"
else fail "unsupported OS fails (code=$code) $out"; fi

# Fallback to ~/.local/bin when /usr/local/bin is unwritable (no override).
mkdir -p "$TMP/home"
out=$(STUB_S=Linux STUB_M=x86_64 PATH="$TMP/stub:$PATH" HOME="$TMP/home" \
  LIGHTPATH_BASE_URL="file://$rel" LIGHTPATH_FORCE_USER_DIR=1 sh "$INSTALL" 2>&1)
code=$?
if [ "$code" -eq 0 ] && [ -x "$TMP/home/.local/bin/lightpath" ] && printf '%s' "$out" | grep -q PATH; then
  pass "falls back to ~/.local/bin with PATH hint"
else
  fail "falls back to ~/.local/bin with PATH hint (code=$code) $out"
fi

# traceroute warning when missing: hide it with a minimal PATH of required tools.
mkdir -p "$TMP/minbin"
for t in sh tar curl wget mkdir cp chmod mv rm mktemp grep awk cut sed shasum sha256sum id dirname tr head cat install ln; do
  p=$(command -v "$t" 2>/dev/null) && [ -x "$p" ] && ln -sf "$p" "$TMP/minbin/$t"
done
cp "$TMP/stub/uname" "$TMP/minbin/uname"
dest="$TMP/dest-tr"; mkdir -p "$dest"
out=$(STUB_S=Linux STUB_M=x86_64 PATH="$TMP/minbin" HOME="$TMP/home" \
  LIGHTPATH_BASE_URL="file://$rel" LIGHTPATH_INSTALL_DIR="$dest" /bin/sh "$INSTALL" 2>&1)
code=$?
if [ "$code" -eq 0 ] && printf '%s' "$out" | grep -qi 'traceroute'; then pass "warns when traceroute is missing"
else fail "warns when traceroute is missing (code=$code) $out"; fi

if [ "$fails" -ne 0 ]; then printf '%s test(s) failed\n' "$fails"; exit 1; fi
echo "all install tests passed"
