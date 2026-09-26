#!/usr/bin/env bash
# Ferminux Validator - Linux installer (systemd).
#
#   sudo ./install.sh [--no-key] [--no-start] [--allow-inbound]
#
# Step 1 of the validator plan (checkpoint validator nodes). It installs
# ferminux (the chain 3961 node) and fmx-validator (the sidecar that runs the
# node, signs checkpoint attestations and keeps the slashing-protection
# database), then sets them up with the sidecar's own commands:
#
#   fmx-validator keys new --data-dir /var/lib/fmx-validator \
#       --password-file /etc/fmx-validator/attester-password
#   fmx-validator install --data-dir /var/lib/fmx-validator --network mainnet \
#       --node-path /usr/local/lib/fmx-validator/ferminux --user fmx-validator \
#       --password-file /etc/fmx-validator/attester-password --start
#
# The result is one hardened systemd unit, fmx-validator.service, running the
# sidecar as the unprivileged fmx-validator user; the sidecar starts the node
# (IPC only, no HTTP, no block production) and stops it in order. The attester
# key's password is a random one in /etc/fmx-validator/attester-password
# (root:root, 0600), handed to the service by systemd (LoadCredential=), so the
# service user never reads the file itself.
#
# Options:
#   --no-key         do not create an attester key (for example, to import one
#                    from another machine with `fmx-validator keys import`)
#   --no-start       write the unit but do not enable or start it; later:
#                    systemctl enable --now fmx-validator
#   --allow-inbound  let the node map its P2P port on the router (UPnP/NAT-PMP);
#                    by default it only dials out and needs no inbound port
#
# It moves no FMX and needs no wallet key: the seat is opened later from the
# owner's own wallet. A validator node checks blocks and signs checkpoint
# attestations; it does not produce blocks and changes nothing in consensus.
set -euo pipefail

SERVICE_USER="fmx-validator"
DATA_DIR="/var/lib/fmx-validator"   # fmx-validator's own default when run as root
NETWORK="mainnet"
BIN_DIR="/usr/local/bin"
NODE_DIR="/usr/local/lib/fmx-validator" # the node binary the sidecar runs, apart from any other ferminux install
CRED_DIR="/etc/fmx-validator"
PASSWORD_FILE="$CRED_DIR/attester-password"
UNIT="fmx-validator.service"
LEGACY_NODE_UNIT="/etc/systemd/system/fmx-node.service"

make_key=1
start=1
inbound=false
for arg in "$@"; do
  case "$arg" in
    --no-key) make_key=0 ;;
    --no-start) start=0 ;;
    --allow-inbound) inbound=true ;;
    -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sidecar="$BIN_DIR/fmx-validator"

log()  { printf '==> %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh must be run as root (sudo ./install.sh)." >&2
  echo "It creates a system user and writes to /usr/local, /var/lib, /etc and /etc/systemd." >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
  echo "This installer needs systemd. Without it, run 'fmx-validator run' under your own supervisor." >&2
  exit 1
fi
for bin in ferminux fmx-validator; do
  if [ ! -f "$here/$bin" ]; then
    echo "Expected to find '$here/$bin'. Run this script from the extracted release" >&2
    echo "folder: it must contain ferminux, fmx-validator and install.sh together." >&2
    exit 1
  fi
done

if systemctl is-active --quiet "$UNIT"; then
  log "Stopping $UNIT before upgrading (the sidecar stops its node first)"
  systemctl stop "$UNIT"
fi
# The pre-release packaging ran the node as a separate fmx-node.service; the
# sidecar runs it now, so that unit would only be a second node on the same port.
if [ -f "$LEGACY_NODE_UNIT" ]; then
  log "Removing the old fmx-node.service (the sidecar runs the node now)"
  systemctl disable --now fmx-node.service 2>/dev/null || true
  rm -f "$LEGACY_NODE_UNIT"
  systemctl daemon-reload
fi

log "Creating the $SERVICE_USER system user"
if id "$SERVICE_USER" >/dev/null 2>&1; then
  note "$SERVICE_USER already exists; reusing it."
else
  nologin="$(command -v nologin || echo /usr/sbin/nologin)"
  useradd --system --home-dir "$DATA_DIR" --no-create-home --shell "$nologin" "$SERVICE_USER"
fi

log "Installing the programs"
install -d -m 0755 -o root -g root "$NODE_DIR"
install -m 0755 -o root -g root "$here/ferminux" "$NODE_DIR/ferminux"
install -m 0755 -o root -g root "$here/fmx-validator" "$sidecar"
note "$sidecar"
note "$NODE_DIR/ferminux"

if [ ! -d "$DATA_DIR" ]; then
  install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
fi

key_file="$DATA_DIR/$NETWORK/keys/attester.json"
if [ -f "$key_file" ]; then
  log "An attester key already exists; keeping it"
  "$sidecar" keys show --data-dir "$DATA_DIR" --network "$NETWORK"
  if [ ! -f "$PASSWORD_FILE" ]; then
    echo >&2
    echo "WARNING: $PASSWORD_FILE is missing, so the service cannot open this key." >&2
    echo "Put the key's password there (root only), then run this installer again:" >&2
    echo "    sudo install -d -m 0700 $CRED_DIR" >&2
    echo "    sudo install -m 0600 -o root -g root /dev/stdin $PASSWORD_FILE   # type it, then Ctrl-D" >&2
    echo >&2
  fi
elif [ "$make_key" -eq 1 ]; then
  log "Creating the attester key"
  install -d -m 0700 -o root -g root "$CRED_DIR"
  if [ ! -f "$PASSWORD_FILE" ]; then
    (umask 077 && head -c 32 /dev/urandom | base64 | tr -d '\n=' > "$PASSWORD_FILE.tmp")
    chown root:root "$PASSWORD_FILE.tmp"
    chmod 0600 "$PASSWORD_FILE.tmp"
    mv -f "$PASSWORD_FILE.tmp" "$PASSWORD_FILE"
    note "A random password for it is in $PASSWORD_FILE (root only)."
  fi
  "$sidecar" keys new --data-dir "$DATA_DIR" --network "$NETWORK" --password-file "$PASSWORD_FILE"
else
  log "No attester key yet (--no-key)"
  note "Import one later: sudo fmx-validator keys import --keystore <file.json> --password-file $PASSWORD_FILE"
fi

log "Registering $UNIT"
args=(install --data-dir "$DATA_DIR" --network "$NETWORK" --node-path "$NODE_DIR/ferminux"
      --user "$SERVICE_USER" "--allow-inbound=$inbound")
if [ -f "$PASSWORD_FILE" ]; then
  args+=(--password-file "$PASSWORD_FILE")
fi
if [ "$start" -eq 1 ]; then
  args+=(--start)
fi
if ! "$sidecar" "${args[@]}"; then
  echo >&2
  echo "fmx-validator install failed; its message is above." >&2
  journalctl -u "$UNIT" -n 20 --no-pager >&2 2>/dev/null || true
  exit 1
fi

if [ "$start" -eq 1 ]; then
  # Type=simple counts as started once the process runs; give it a moment to settle
  sleep 5
  if systemctl is-active --quiet "$UNIT"; then
    log "Status"
    "$sidecar" status --data-dir "$DATA_DIR" --network "$NETWORK" || true
  else
    echo >&2
    echo "WARNING: $UNIT is not running. What it recorded:" >&2
    "$sidecar" status --data-dir "$DATA_DIR" --network "$NETWORK" >&2 || true
    journalctl -u "$UNIT" -n 20 --no-pager >&2 || true
    exit 1
  fi
fi

echo
echo "Ferminux Validator is installed."
echo
echo "Networking: the node dials out to the bootnodes and the known public nodes."
if [ "$inbound" = true ]; then
  echo "It may also map port 30303 on your router; open TCP/UDP 30303 in your firewall for inbound peers."
else
  echo "No inbound port is needed, and this installer does not touch your firewall."
fi
echo
echo "Next steps (this installer never moves funds):"
echo "  1. Back up $key_file and $PASSWORD_FILE"
echo "     somewhere other than this server."
echo "  2. Send about 1 FMX to the attester address above for transaction fees."
echo "  3. Once the ValidatorHub address is published, open your seat from your own wallet:"
echo "       sudo fmx-validator seat-proof --password-file $PASSWORD_FILE --owner <your wallet address>"
echo
echo "Check on it:"
echo "    sudo fmx-validator status"
echo "    journalctl -u $UNIT -f"
echo "    sudo tail -f $DATA_DIR/$NETWORK/logs/node.log"
