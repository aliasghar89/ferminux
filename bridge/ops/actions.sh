#!/usr/bin/env bash
#
# Inspect and execute bridge timelock actions.
#
#   bash actions.sh list                 # every queued action on both chains
#   bash actions.sh exec <fmx|bsc> <id>  # execute one that has matured
#
# Every privileged change to either bridge goes through queue() -> wait ->
# executeAction(). This is the tool for the second half of that, and for
# answering "what is pending against me right now" — which is the question the
# timelock exists to let you ask before a change lands.
#
# If you see an action here that YOU did not queue, that is the emergency the
# design is built around. Two responses, both instant and neither timelocked:
#   cancelAction(<id>) through the multisig, if you still control it, or
#   pause() with the pauser key, which stops every transfer immediately.
set -euo pipefail

FMX_RPC=https://rpc.ferminux.net
BSC_RPC=https://bsc-dataseed.bnbchain.org
FMX_BRIDGE=0xe162eeDa683f067d4Ebf61060Fa322332a779EF4
BSC_BRIDGE=0xe43951a0E421A6B3Cb9C6ae66273dc0D3c8a70ff
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The timelocked setters, by selector, so a queued action can be read as English
# instead of as four opaque bytes. `cast sig` would need the full signature list
# anyway, and this doubles as the authoritative list of what CAN be queued.
selector_name() {
  case "$1" in
    0x909ec07a) echo "registerCanonical" ;;
    0xf3b3b7b4) echo "registerWrapped" ;;
    0x9c199e15) echo "setBridgeTokenCodehash" ;;
    0xffa739df) echo "setRemoteBridge" ;;
    0x3821933a) echo "setTimelockDelay" ;;
    *)          echo "unknown($1)" ;;
  esac
}

chain_params() {
  case "$1" in
    fmx) RPC=$FMX_RPC; BRIDGE=$FMX_BRIDGE ;;
    bsc) RPC=$BSC_RPC; BRIDGE=$BSC_BRIDGE ;;
    *) echo "unknown chain '$1'" >&2; exit 2 ;;
  esac
}

list_chain() {
  local ch="$1"; chain_params "$ch"
  local delay count now
  delay=$(cast call --rpc-url "$RPC" "$BRIDGE" "timelockDelay()(uint64)" | awk '{print $1}')
  count=$(cast call --rpc-url "$RPC" "$BRIDGE" "actionCount()(uint256)" | awk '{print $1}')
  now=$(date +%s)
  echo "=== $ch  $BRIDGE   timelock ${delay}s ($((delay / 3600))h)   paused=$(cast call --rpc-url "$RPC" "$BRIDGE" "paused()(bool)")"
  if [ "$count" -eq 0 ]; then echo "    no actions ever queued"; return; fi
  local i out data eta ex ca state
  for ((i = 0; i < count; i++)); do
    out=$(cast call --rpc-url "$RPC" "$BRIDGE" "getAction(uint256)(bytes,uint64,bool,bool)" "$i" 2>/dev/null) || continue
    data=$(echo "$out" | sed -n '1p' | tr -d ' ')
    eta=$(echo "$out" | sed -n '2p' | awk '{print $1}')
    ex=$(echo "$out" | sed -n '3p' | tr -d ' ')
    ca=$(echo "$out" | sed -n '4p' | tr -d ' ')
    if   [ "$ex" = "true" ]; then state="executed"
    elif [ "$ca" = "true" ]; then state="canceled"
    elif [ "$now" -lt "$eta" ]; then state="PENDING, $(( (eta - now) / 60 ))m to go"
    # A matured action is only executable for GRACE_PERIOD (72h); after that it
    # is dead and must be queued again.
    elif [ "$now" -gt $((eta + 259200)) ]; then state="STALE — past the 72h grace window, re-queue it"
    else state="READY — $(( (now - eta) / 60 ))m past its eta"
    fi
    printf "    [%s] %-24s %-42s %s\n" "$i" "$(selector_name "${data:0:10}")" "$state" "eta $(date -r "$eta" '+%Y-%m-%d %H:%M:%S')"
  done
}

case "${1:-list}" in
  list)
    list_chain fmx
    list_chain bsc
    ;;
  exec)
    CH="${2:?usage: actions.sh exec <fmx|bsc> <id>}"
    ID="${3:?action id required}"
    chain_params "$CH"
    OUT=$(cast call --rpc-url "$RPC" "$BRIDGE" "getAction(uint256)(bytes,uint64,bool,bool)" "$ID")
    ETA=$(echo "$OUT" | sed -n '2p' | awk '{print $1}')
    EX=$(echo "$OUT" | sed -n '3p' | tr -d ' ')
    CA=$(echo "$OUT" | sed -n '4p' | tr -d ' ')
    [ "$EX" = "true" ] && { echo "action $ID on $CH already executed"; exit 0; }
    [ "$CA" = "true" ] && { echo "action $ID on $CH was canceled"; exit 1; }
    NOW=$(date +%s)
    [ "$NOW" -lt "$ETA" ] && { echo "not matured — $(( (ETA - NOW) / 60 )) minutes to go"; exit 1; }
    echo "executing $(selector_name "$(echo "$OUT" | sed -n '1p' | tr -d ' ' | cut -c1-10)") as action $ID on $CH"
    bash "$HERE/msig.sh" "$CH" "$BRIDGE" "$(cast calldata "executeAction(uint256)" "$ID")"
    list_chain "$CH"
    ;;
  *)
    echo "usage: actions.sh [list | exec <fmx|bsc> <id>]" >&2; exit 2 ;;
esac
