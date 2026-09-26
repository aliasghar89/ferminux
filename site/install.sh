#!/usr/bin/env bash
# Ferminux Network — one-line node installer.
#
#   curl -fsSL https://ferminux.net/install.sh | bash
#
# Installs Ferminux Node (one static binary) for linux amd64/arm64 or macOS
# Apple Silicon, verifies its SHA-256, and prints the two commands that
# matter. The genesis and bootnodes are baked into the binary — a fresh
# datadir joins chain 3961 automatically.
#
# The command is `ferminux`. `ferminux-geth` is installed alongside it as a
# symlink and stays INDEFINITELY: this script is served live at
# https://ferminux.net/install.sh and people have piped it into cron.
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

# New artefact name first, previously published name as the fallback. Archives
# already listed in SHA256SUMS.txt are pinned BY NAME inside that checksum list,
# so the old names are never renamed or removed — only added to.
#
# What the check proves, and what it does not: SHA256SUMS.txt comes from the same
# host as the archive and is NOT signed, so it catches a corrupted or truncated
# download, not a tampered web root. A detached signature over the list is the
# fix, and it is not published yet.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL -o "$tmp/SHA256SUMS.txt" "$BASE/SHA256SUMS.txt"

# Choose by the checksum list, never by HTTP status: the site answers unknown
# paths with 200 + the HTML index, so "curl succeeded" proves nothing.
file=""
for candidate in "ferminux-${target}.tar.gz" "ferminux-geth-${target}.tar.gz"; do
  if grep -q " $candidate\$" "$tmp/SHA256SUMS.txt"; then file="$candidate"; break; fi
done
[ -n "$file" ] || { echo "No release archive found for $target." >&2; exit 1; }
echo "Downloading $file ..."
curl -fsSL -o "$tmp/$file" "$BASE/$file"

echo "Verifying checksum ..."
expected="$(grep " $file\$" "$tmp/SHA256SUMS.txt" | awk '{print $1}')"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$file" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$tmp/$file" | awk '{print $1}')"
fi
[ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "CHECKSUM MISMATCH — aborting." >&2; exit 1; }

tar -xzf "$tmp/$file" -C "$tmp"

# The archive may carry either binary name; normalise to `ferminux`.
bin=""
for candidate in "$tmp/ferminux" "$tmp/ferminux-geth"; do
  [ -f "$candidate" ] && { bin="$candidate"; break; }
done
[ -n "$bin" ] || { echo "Archive did not contain a node binary." >&2; exit 1; }

# install_node <dir> [sudo]
install_node() {
  local d="$1" sudo_cmd="${2:-}"
  $sudo_cmd install -m 0755 "$bin" "$d/ferminux"
  # Compatibility name — kept indefinitely, not for one release.
  $sudo_cmd ln -sf "$d/ferminux" "$d/ferminux-geth"
}

dest="/usr/local/bin"
if [ -w "$dest" ]; then
  install_node "$dest"
elif command -v sudo >/dev/null 2>&1; then
  echo "Installing to $dest (sudo) ..."
  install_node "$dest" sudo
else
  dest="$HOME/.local/bin"; mkdir -p "$dest"
  install_node "$dest"
  echo "NOTE: installed to $dest — make sure it is on your PATH."
fi

echo
echo "Ferminux Node installed: $("$dest/ferminux" version | head -2 | tr '\n' ' ')"
echo "(the previous command name, ferminux-geth, still works)"
echo
echo "Run a node (it follows chain 3961 and serves the network):"
echo "    ferminux"
echo
echo "Attach a console to a running node:"
echo "    ferminux attach"
echo
echo "Blocks are confirmed by the Ferminux signer set. Running a node does not"
echo "make you a signer; signer authorisation is granted on-chain."
echo
echo "Headless server (systemd) setup: https://ferminux.net  ·  docs in the repo /docs"
