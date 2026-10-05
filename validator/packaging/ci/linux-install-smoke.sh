#!/usr/bin/env bash
# CI smoke test for the Linux packaging, on a machine with real systemd (a
# GitHub runner). It runs the staged release's install.sh, checks what it
# set up, starts the service against a devnet configuration that talks to no
# network at all, checks the password reaches the sidecar through systemd's
# LoadCredential=, checks an upgrade that install refuses names every file and
# leaves the service running, breaks the configuration to check a failed start
# says why, and uninstalls everything.
#
# Nothing here joins chain 3961 or any public network: the mainnet install is
# registered with --no-start, and the service that does run is a devnet
# sidecar attached to a node address where nothing listens.
#
#   sudo validator/packaging/ci/linux-install-smoke.sh <staged release dir>
#
# SKIP_CREDENTIAL_CHECK=1 skips the LoadCredential= check, for containers
# where systemd cannot set up credentials at all.
set -euo pipefail

rel="${1:?usage: linux-install-smoke.sh <staged release dir>}"
rel="$(cd "$rel" && pwd)"
DATA_DIR=/var/lib/fmx-validator
PASSWORD_FILE=/etc/fmx-validator/attester-password
UNIT=fmx-validator.service
UNIT_FILE="/etc/systemd/system/$UNIT"
DEV_CHAIN=31337
# any address: the devnet sidecar only needs one configured to go on to open its key
DEV_HUB=0x5FbDB2315678afecb367f032d93F642f64180aa3

fail() { echo "FAIL: $*" >&2; journalctl -u "$UNIT" -n 30 --no-pager >&2 || true; exit 1; }
ok()   { echo "OK: $*"; }

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

echo "==> install.sh --no-start"
"$rel/install.sh" --no-start
[ -x /usr/local/bin/fmx-validator ] || fail "fmx-validator not installed"
[ -x /usr/local/lib/fmx-validator/ferminux ] || fail "node not installed"
id fmx-validator >/dev/null || fail "no fmx-validator user"
[ "$(stat -c '%U %a' "$PASSWORD_FILE")" = "root 600" ] || fail "password file is not root 0600: $(stat -c '%U %a' "$PASSWORD_FILE")"
[ "$(stat -c '%U %a' "$DATA_DIR/mainnet")" = "fmx-validator 700" ] || fail "network directory is not fmx-validator 0700"
[ "$(stat -c '%U' "$DATA_DIR/mainnet/keys/attester.json")" = fmx-validator ] || fail "key not handed to the service user"
grep -q '^ExecStart=/usr/local/bin/fmx-validator run --data-dir /var/lib/fmx-validator --network mainnet$' "$UNIT_FILE" || fail "unexpected ExecStart"
grep -q "^LoadCredential=attester-password:$PASSWORD_FILE$" "$UNIT_FILE" || fail "no LoadCredential line"
grep -q '"binary": "/usr/local/lib/fmx-validator/ferminux"' "$DATA_DIR/mainnet/config.json" || fail "config does not supervise the installed node"
systemd-analyze verify "$UNIT_FILE" || fail "systemd-analyze verify"
if systemctl is-active --quiet "$UNIT"; then fail "--no-start started the service"; fi
ok "mainnet install registered, not started"

echo "==> devnet service: start, status, password through LoadCredential="
fmx-validator keys new --data-dir "$DATA_DIR" --network devnet --chain-id "$DEV_CHAIN" --password-file "$PASSWORD_FILE"
fmx-validator init --data-dir "$DATA_DIR" --network devnet --chain-id "$DEV_CHAIN" --hub "$DEV_HUB" --node-ipc http://127.0.0.1:9
fmx-validator install --data-dir "$DATA_DIR" --network devnet --chain-id "$DEV_CHAIN" --user fmx-validator \
  --password-file "$PASSWORD_FILE" --start || fail "devnet service did not start"
sleep 3
systemctl is-active --quiet "$UNIT" || fail "devnet service not active"
out="$(fmx-validator status --data-dir "$DATA_DIR" --network devnet)"
echo "$out"
grep -q 'state ' <<<"$out" || fail "status has no state line"
if [ "${SKIP_CREDENTIAL_CHECK:-0}" != 1 ]; then
  # opening the key runs its scrypt KDF, which takes a while on a slow or emulated CPU
  opened=0
  for _ in $(seq 1 90); do
    if grep -q 'attester key opened .*password="systemd credential attester-password"' "$DATA_DIR/devnet/logs/fmx-validator.log" 2>/dev/null; then
      opened=1; break
    fi
    sleep 1
  done
  [ "$opened" = 1 ] || fail "the key was not opened with the systemd credential"
  ok "password delivered by LoadCredential="
fi
ok "devnet service running"

echo "==> an upgrade over root-owned leftovers: all named, the service started again"
# what a root run of an earlier release left in the service user's directories
left=("$DATA_DIR/mainnet/root-leftover" "$DATA_DIR/mainnet/keys/root-leftover")
for f in "${left[@]}"; do printf x > "$f"; done
if out="$("$rel/install.sh" 2>&1)"; then
  echo "$out"
  fail "install.sh handed over root-owned files"
fi
echo "$out"
for f in "${left[@]}"; do
  grep -qF "$f (uid 0)" <<<"$out" || fail "install.sh did not name $f"
  [ "$(stat -c '%u' "$f")" = 0 ] || fail "$f was handed over"
done
sleep 3
systemctl is-active --quiet "$UNIT" || fail "a failed upgrade left $UNIT stopped"
rm -f "${left[@]}"
ok "failed upgrade named every leftover and started the service again"

echo "==> a broken config.json: the start fails and says why"
systemctl stop "$UNIT"
cp "$DATA_DIR/devnet/config.json" /tmp/devnet-config.json
printf '{"network":"devnet","chainId":%s,"surprise":true}\n' "$DEV_CHAIN" > "$DATA_DIR/devnet/config.json"
systemctl start "$UNIT" || true
sleep 3
out="$(fmx-validator status --data-dir "$DATA_DIR" --network devnet)"
echo "$out"
grep -q 'last run  failed:.*surprise' <<<"$out" || fail "status does not say why the start failed"
# read the journal first: `journalctl | grep -q` fails under pipefail once grep stops reading early
journal="$(journalctl -u "$UNIT" --no-pager)"
grep -q 'surprise' <<<"$journal" || fail "the journal does not say why the start failed"
systemctl stop "$UNIT" || true
cp /tmp/devnet-config.json "$DATA_DIR/devnet/config.json"
ok "failed start reported"

echo "==> uninstall.sh --remove-data"
"$rel/uninstall.sh" --remove-data
for p in "$UNIT_FILE" /usr/local/bin/fmx-validator /usr/local/lib/fmx-validator "$DATA_DIR" /etc/fmx-validator; do
  [ ! -e "$p" ] || fail "$p left behind"
done
if id fmx-validator >/dev/null 2>&1; then fail "fmx-validator user left behind"; fi
ok "uninstalled"
echo "==> Linux packaging smoke test passed."
