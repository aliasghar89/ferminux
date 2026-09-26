#!/usr/bin/env bash
# Ferminux Validator - Linux uninstaller (systemd).
#
#   sudo ./uninstall.sh                 # keeps /var/lib/fmx-validator and /etc/fmx-validator
#   sudo ./uninstall.sh --remove-data   # also deletes them, and the fmx-validator user
#
# Stops and removes fmx-validator.service (`fmx-validator uninstall`; the
# sidecar stops its node first) and the installed programs. The data
# directory holds the attester key and its slashing-protection database, and
# /etc/fmx-validator holds the key's password: they are kept unless
# --remove-data is given, because a key without its history is how a
# validator ends up signing twice.
set -euo pipefail

SERVICE_USER="fmx-validator"
DATA_DIR="/var/lib/fmx-validator"
BIN_DIR="/usr/local/bin"
NODE_DIR="/usr/local/lib/fmx-validator"
CRED_DIR="/etc/fmx-validator"
UNIT="fmx-validator.service"
UNIT_FILE="/etc/systemd/system/$UNIT"
LEGACY_NODE_UNIT="/etc/systemd/system/fmx-node.service"

remove_data=0
for arg in "$@"; do
  case "$arg" in
    --remove-data) remove_data=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

log() { printf '==> %s\n' "$1"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "uninstall.sh must be run as root (sudo ./uninstall.sh)." >&2
  exit 1
fi

if [ -f "$UNIT_FILE" ]; then
  log "Stopping and removing $UNIT"
  if [ -x "$BIN_DIR/fmx-validator" ]; then
    "$BIN_DIR/fmx-validator" uninstall
  else
    systemctl disable --now "$UNIT" 2>/dev/null || true
    rm -f "$UNIT_FILE"
    systemctl daemon-reload
  fi
else
  log "$UNIT is not installed"
fi
# the pre-release packaging's separate node unit
if [ -f "$LEGACY_NODE_UNIT" ]; then
  log "Removing the old fmx-node.service"
  systemctl disable --now fmx-node.service 2>/dev/null || true
  rm -f "$LEGACY_NODE_UNIT"
  systemctl daemon-reload
fi

log "Removing the programs"
rm -f "$BIN_DIR/fmx-validator"
rm -rf "$NODE_DIR"

if [ "$remove_data" -eq 1 ]; then
  echo
  echo "WARNING: deleting $DATA_DIR (attester key, slashing-protection database, chain" >&2
  echo "data) and $CRED_DIR (the key's password). The seat and its deposit on chain are" >&2
  echo "not affected, but a key that is not backed up elsewhere is gone for good." >&2
  rm -rf "$DATA_DIR" "$CRED_DIR"
  echo "Removed $DATA_DIR and $CRED_DIR."
  if id "$SERVICE_USER" >/dev/null 2>&1; then
    log "Removing the $SERVICE_USER system user"
    userdel "$SERVICE_USER" 2>/dev/null || true
  fi
else
  echo
  for d in "$DATA_DIR" "$CRED_DIR"; do
    if [ -d "$d" ]; then echo "Kept $d."; fi
  done
  echo "Run again with --remove-data only if you really want those deleted too."
fi

echo
echo "Ferminux Validator uninstalled."
echo "Your seat and its 2,000 FMX deposit are on chain and were not touched. To get the"
echo "deposit back, request an exit from the owner wallet; it can be withdrawn after the"
echo "14-day unbonding period."
