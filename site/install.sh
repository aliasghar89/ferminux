#!/usr/bin/env bash
# Ferminux Network — one-line node installer.
#
#   curl -fsSL https://ferminux.net/install.sh | bash
#
# Installs ferminux-geth (node + CPU miner in one static binary) for
# linux amd64/arm64 or macOS Apple Silicon, verifies its SHA-256, and
# prints the two commands that matter. The genesis and bootnodes are baked
# into the binary — a fresh datadir joins ChainID 3961 automatically.
set -euo pipefail

BASE="https://ferminux.net/downloads"

os="$(uname -s)"; arch="$(uname -m)"
case "$os/$arch" in
  Linux/x86_64)          target="linux-amd64"  ;;
  Linux/aarch64|Linux/arm64) target="linux-arm64" ;;
  Darwin/arm64)          target="macos-arm64"  ;;
  Darwin/x86_64)
    echo "Intel macOS builds are not published yet — build from source (/chain) or use Docker." >&2; exit 1 ;;
  *)
    echo "Unsupported platform: $os/$arch (Windows builds ship via the release CI)." >&2; exit 1 ;;
esac

file="ferminux-geth-${target}.tar.gz"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $file ..."
curl -fsSL -o "$tmp/$file" "$BASE/$file"
curl -fsSL -o "$tmp/SHA256SUMS.txt" "$BASE/SHA256SUMS.txt"

echo "Verifying checksum ..."
expected="$(grep " $file\$" "$tmp/SHA256SUMS.txt" | awk '{print $1}')"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$file" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$tmp/$file" | awk '{print $1}')"
fi
[ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "CHECKSUM MISMATCH — aborting." >&2; exit 1; }

tar -xzf "$tmp/$file" -C "$tmp"

dest="/usr/local/bin"
if [ -w "$dest" ]; then
  install -m 0755 "$tmp/ferminux-geth" "$dest/ferminux-geth"
elif command -v sudo >/dev/null 2>&1; then
  echo "Installing to $dest (sudo) ..."
  sudo install -m 0755 "$tmp/ferminux-geth" "$dest/ferminux-geth"
else
  dest="$HOME/.local/bin"; mkdir -p "$dest"
  install -m 0755 "$tmp/ferminux-geth" "$dest/ferminux-geth"
  echo "NOTE: installed to $dest — make sure it is on your PATH."
fi

echo
echo "ferminux-geth installed: $("$dest/ferminux-geth" version | head -2 | tr '\n' ' ')"
echo
echo "Run a node (keeps the network alive):"
echo "    ferminux-geth"
echo
echo "Mine FMX (6 FMX per ~7s block, paid to your address):"
echo "    ferminux-geth --mine --miner.threads 2 --miner.etherbase 0xYourAddress"
echo
echo "Headless server (systemd) setup and GPU mining: https://ferminux.net  ·  docs in the repo /docs"
