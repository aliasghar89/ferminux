#!/usr/bin/env bash
# Build the Ferminux Validator release packages outside GitHub Actions.
#
#   validator/packaging/release/build.sh --version v0.1.0-pilot.1 --out <dir> [--ref HEAD]
#
# Produces, in <dir>:
#   ferminux-validator-windows-amd64.zip   ferminux.exe, fmx-validator.exe, install.ps1,
#                                          uninstall.ps1, README.txt (flat, as the CI zips it)
#   ferminux-validator-linux-amd64.tar.gz  ferminux-validator-linux-amd64/{ferminux,
#   ferminux-validator-linux-arm64.tar.gz    fmx-validator, install.sh, uninstall.sh, README.txt}
#   SHA256SUMS                             sha256 of the three archives (sha256sum format)
#   BUILDINFO.txt                          source commit, toolchains, build method and the
#                                          sha256 of every program inside the archives
#
# The package layout is the one .github/workflows/validator-release.yml stages. What
# differs is where the programs are compiled, because this runs on a build machine
# instead of a Windows runner and an Ubuntu runner:
#
#   windows/amd64 node  cgo, cross-compiled with mingw-w64 gcc (x86_64-w64-mingw32-gcc),
#                       the compiler family the release workflow installs on its Windows
#                       runner (MSYS2 mingw-w64-x86_64-gcc) and the method the repo-root
#                       windows/build-package.sh documents. The script refuses a result that
#                       needs any DLL beyond the ones every Windows 10/11 has.
#   linux nodes         CGO_ENABLED=0, -tags netgo,osusergo: static, pure-Go secp256k1.
#                       Runs on any 64-bit Linux, whatever its glibc. The same method as
#                       validator/devnet/build.sh (the Step 1 devnet ran these builds) and
#                       infra/lab/phase0-build.sh.
#   sidecars            CGO_ENABLED=0, as the validator Makefile and the workflow build them.
#
# Everything is Go 1.20.14 (GOTOOLCHAIN pins it), -trimpath, from a clean `git archive`
# of <ref> (default HEAD), so edits in the working tree never reach a package. Archives
# are reproducible: fixed mtimes (the commit time), fixed order, no owner names.
#
# Needs: git, go (any version that can fetch go1.20.14), zip, tar, gzip, and for the
# Windows node x86_64-w64-mingw32-gcc (macOS: `brew install mingw-w64`; Debian/Ubuntu:
# `apt install gcc-mingw-w64-x86-64`). WINDOWS_CC / WINDOWS_CXX override the compiler.
#
# This script builds and packages only. It never uploads, deploys or signs anything, and
# nothing it runs talks to chain 3961 or any other network. Run
# validator/packaging/release/smoke-docker.sh <dir> afterwards for the smoke tests.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
GO_VERSION="go1.20.14"
REF="HEAD"
VERSION=""
OUT=""
WINDOWS_CC="${WINDOWS_CC:-x86_64-w64-mingw32-gcc}"
WINDOWS_CXX="${WINDOWS_CXX:-x86_64-w64-mingw32-g++}"
WINDOWS_OBJDUMP="${WINDOWS_OBJDUMP:-x86_64-w64-mingw32-objdump}"

usage() { sed -n '2,40p' "$0"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:?--ref needs a value}"; shift 2 ;;
    --version) VERSION="${2:?--version needs a value}"; shift 2 ;;
    --out) OUT="${2:?--out needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done
[ -n "$VERSION" ] || { echo "--version is required (for example v0.1.0-pilot.1)" >&2; exit 2; }
[ -n "$OUT" ] || { echo "--out is required" >&2; exit 2; }
case "$VERSION" in *[!A-Za-z0-9._+-]*) echo "--version may use only letters, digits and . _ + -" >&2; exit 2 ;; esac

say() { printf '\n==> %s\n' "$*"; }
die() { echo "FAIL: $*" >&2; exit 1; }

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

# ---------------------------------------------------------------- inputs
say "Source"
COMMIT="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")"
SHORT="${COMMIT:0:7}"
COMMIT_DATE="$(git -C "$REPO" log -1 --format=%cd --date=format:%Y%m%d "$COMMIT")"
STAMP="$(TZ=UTC git -C "$REPO" log -1 --format=%cd --date=format-local:%Y%m%d%H%M.%S "$COMMIT")"
FULL_VERSION="$VERSION+$SHORT"
echo "commit   $COMMIT ($REF)"
echo "version  $FULL_VERSION"

export GOTOOLCHAIN="$GO_VERSION"
gov="$(cd "$REPO" && go env GOVERSION)"
[ "$gov" = "$GO_VERSION" ] || die "go resolves to $gov, not $GO_VERSION"
command -v "$WINDOWS_CC" >/dev/null 2>&1 ||
  die "$WINDOWS_CC not found: the Windows node needs cgo (macOS: brew install mingw-w64)"
command -v "$WINDOWS_OBJDUMP" >/dev/null 2>&1 || die "$WINDOWS_OBJDUMP not found (it ships with mingw-w64)"
for t in zip tar gzip; do command -v "$t" >/dev/null 2>&1 || die "$t not found"; done
echo "go       $gov"
echo "mingw    $("$WINDOWS_CC" --version | head -1)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/fmx-validator-release.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
git -C "$REPO" archive --format=tar "$COMMIT" chain validator | tar -x -C "$WORK"
BIN="$WORK/bin"
mkdir -p "$BIN/windows-amd64" "$BIN/linux-amd64" "$BIN/linux-arm64"

# ---------------------------------------------------------------- programs
# The node's own version fields, as chain/build/ci.go sets them.
NODE_LDFLAGS="-X main.gitCommit=$COMMIT -X main.gitDate=$COMMIT_DATE"
SIDECAR_LDFLAGS="-s -w -X main.version=$FULL_VERSION"

say "Node, windows/amd64 (cgo, $WINDOWS_CC)"
( cd "$WORK/chain" && env CGO_ENABLED=1 GOOS=windows GOARCH=amd64 CC="$WINDOWS_CC" CXX="$WINDOWS_CXX" \
    go build -tags urfave_cli_no_docs -trimpath -ldflags "$NODE_LDFLAGS" \
    -o "$BIN/windows-amd64/ferminux.exe" ./cmd/ferminux )

for arch in amd64 arm64; do
  say "Node, linux/$arch (CGO_ENABLED=0, static)"
  ( cd "$WORK/chain" && env CGO_ENABLED=0 GOOS=linux GOARCH=$arch \
      go build -tags netgo,osusergo,urfave_cli_no_docs -trimpath -ldflags "$NODE_LDFLAGS" \
      -o "$BIN/linux-$arch/ferminux" ./cmd/ferminux )
done

for t in windows/amd64 linux/amd64 linux/arm64; do
  os="${t%/*}"; arch="${t#*/}"; ext=""; [ "$os" = windows ] && ext=".exe"
  say "Sidecar, $os/$arch (CGO_ENABLED=0)"
  ( cd "$WORK/validator" && env CGO_ENABLED=0 GOOS=$os GOARCH=$arch \
      go build -trimpath -ldflags "$SIDECAR_LDFLAGS" -o "$BIN/$os-$arch/fmx-validator$ext" ./cmd/fmx-validator )
done

# ---------------------------------------------------------------- checks on the programs
say "Checking what was built"
# go version -m: toolchain, target and cgo setting of every program
check_build() { # check_build <file> <goos> <goarch> <cgo>
  local info; info="$(go version -m "$1")"
  grep -q "^$1: $GO_VERSION\$" <<<"$info" || die "$1 is not built with $GO_VERSION"
  grep -qE "^[[:space:]]+build[[:space:]]+GOOS=$2\$" <<<"$info" || die "$1 is not GOOS=$2"
  grep -qE "^[[:space:]]+build[[:space:]]+GOARCH=$3\$" <<<"$info" || die "$1 is not GOARCH=$3"
  grep -qE "^[[:space:]]+build[[:space:]]+CGO_ENABLED=$4\$" <<<"$info" || die "$1 is not CGO_ENABLED=$4"
  echo "ok  $(basename "$(dirname "$1")")/$(basename "$1")  $GO_VERSION $2/$3 cgo=$4"
}
check_build "$BIN/windows-amd64/ferminux.exe" windows amd64 1
check_build "$BIN/windows-amd64/fmx-validator.exe" windows amd64 0
for arch in amd64 arm64; do
  check_build "$BIN/linux-$arch/ferminux" linux $arch 0
  check_build "$BIN/linux-$arch/fmx-validator" linux $arch 0
done

# The Windows node may import only DLLs that every Windows 10/11 has. A mingw build that
# needs libwinpthread-1.dll or libgcc_s_seh-1.dll would start on the build machine's
# test setup and fail on a clean PC.
dlls="$("$WINDOWS_OBJDUMP" -p "$BIN/windows-amd64/ferminux.exe" | sed -n 's/^[[:space:]]*DLL Name: //p' | sort -u)"
bad="$(grep -viE '^(kernel32|advapi32|setupapi|ws2_32|user32|ntdll|msvcrt|winmm|iphlpapi|api-ms-win-crt-[a-z0-9-]+)\.dll$' <<<"$dlls" || true)"
[ -z "$bad" ] || die "ferminux.exe needs DLLs a clean Windows PC does not have: $(tr '\n' ' ' <<<"$bad")"
dlls="$(paste -sd ' ' - <<<"$dlls")"
echo "ok  ferminux.exe imports only system DLLs: $dlls"

# ---------------------------------------------------------------- packages
say "Packaging"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
PKG="$WORK/validator/packaging" # the packaging scripts from the same commit as the programs
STAGE="$WORK/stage"
export TZ=UTC

# Windows: flat zip, the layout the workflow's `7z a ... .\stage\windows\*` produces
w="$STAGE/windows"; mkdir -p "$w"
cp "$BIN/windows-amd64/ferminux.exe" "$BIN/windows-amd64/fmx-validator.exe" "$w/"
cp "$PKG/windows/install.ps1" "$PKG/windows/uninstall.ps1" "$w/"
cp "$PKG/README-windows.txt" "$w/README.txt"
chmod 0644 "$w"/*
find "$w" -exec touch -t "$STAMP" {} +
rm -f "$OUT/ferminux-validator-windows-amd64.zip"
( cd "$w" && zip -q -X -D "$OUT/ferminux-validator-windows-amd64.zip" \
    README.txt install.ps1 uninstall.ps1 fmx-validator.exe ferminux.exe )
echo "ferminux-validator-windows-amd64.zip"

# Linux: one top-level folder, as the workflow's tarball has it
tar_is_gnu=0; tar --version 2>/dev/null | grep -q 'GNU tar' && tar_is_gnu=1
for arch in amd64 arm64; do
  name="ferminux-validator-linux-$arch"; d="$STAGE/$name"; mkdir -p "$d"
  cp "$BIN/linux-$arch/ferminux" "$BIN/linux-$arch/fmx-validator" "$d/"
  cp "$PKG/linux/install.sh" "$PKG/linux/uninstall.sh" "$d/"
  cp "$PKG/README-linux.txt" "$d/README.txt"
  chmod 0755 "$d" "$d/ferminux" "$d/fmx-validator" "$d/install.sh" "$d/uninstall.sh"
  chmod 0644 "$d/README.txt"
  find "$d" -exec touch -t "$STAMP" {} +
  files=("$name" "$name/README.txt" "$name/install.sh" "$name/uninstall.sh" "$name/fmx-validator" "$name/ferminux")
  if [ "$tar_is_gnu" = 1 ]; then
    ( cd "$STAGE" && tar --format=ustar --owner=0 --group=0 --numeric-owner --no-recursion -cf - "${files[@]}" ) |
      gzip -n -9 > "$OUT/$name.tar.gz"
  else
    ( cd "$STAGE" && COPYFILE_DISABLE=1 tar --format ustar --uid 0 --gid 0 --uname root --gname root \
        --no-xattrs --no-mac-metadata -n -cf - "${files[@]}" ) | gzip -n -9 > "$OUT/$name.tar.gz"
  fi
  echo "$name.tar.gz"
done

( cd "$OUT" && sha256 ferminux-validator-windows-amd64.zip ferminux-validator-linux-amd64.tar.gz \
    ferminux-validator-linux-arm64.tar.gz > SHA256SUMS )

# ---------------------------------------------------------------- build record
{
  echo "Ferminux Validator $FULL_VERSION"
  echo
  echo "source     $COMMIT (chain/ and validator/ at that commit, via git archive)"
  echo "built      $(date -u +%Y-%m-%dT%H:%M:%SZ) on $(uname -s)/$(uname -m)"
  echo "toolchain  $gov (GOTOOLCHAIN), -trimpath"
  echo "windows    ferminux.exe: cgo, $("$WINDOWS_CC" --version | head -1), cross-compiled;"
  echo "           imports only: $dlls"
  echo "linux      ferminux: CGO_ENABLED=0, -tags netgo,osusergo (static, pure-Go secp256k1)"
  echo "sidecar    fmx-validator: CGO_ENABLED=0, -ldflags \"-s -w -X main.version=$FULL_VERSION\""
  echo "signing    none: the programs are not code-signed and SHA256SUMS is not signed"
  echo
  echo "Archives (the same lines as SHA256SUMS):"
  sed 's/^/  /' "$OUT/SHA256SUMS"
  echo
  echo "Programs inside them:"
  for p in windows-amd64/ferminux.exe windows-amd64/fmx-validator.exe \
           linux-amd64/ferminux linux-amd64/fmx-validator linux-arm64/ferminux linux-arm64/fmx-validator; do
    printf '  %s  %s\n' "$(sha256 "$BIN/$p" | awk '{print $1}')" "$p"
  done
} > "$OUT/BUILDINFO.txt"

say "Done: $OUT"
cat "$OUT/SHA256SUMS"
