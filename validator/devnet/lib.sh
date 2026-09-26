# shellcheck shell=bash
# Helpers shared by the devnet scripts. Source after setting HERE.
export DOCKER_CONTEXT=${DOCKER_CONTEXT:-colima-fmxdev}
RUN="$HERE/.run"
EVD="$HERE/evidence"
REPO=$(cd "$HERE/../.." && pwd)
RPC=${RPC:-http://127.0.0.1:39545}
. "$RUN/devnet.env"
[ -s "$RUN/deployments.json" ] && {
  HUB=$(jq -r .validatorHub "$RUN/deployments.json")
  LENS=$(jq -r .validatorHubLens "$RUN/deployments.json")
  ROUTER=$(jq -r .sinkRouter "$RUN/deployments.json")
}
TIP=1gwei
# custom-error selectors of the validator contracts, to name reverts in the logs
if [ ! -s "$RUN/errors.txt" ]; then
  for n in ValidatorHub ValidatorHubLens SinkRouter; do
    jq -r '.abi[]|select(.type=="error")|.name + "(" + ([.inputs[].type]|join(",")) + ")"' "$REPO/agents/contracts/out/$n.sol/$n.json"
  done | sort -u | while read -r e; do echo "$(cast sig "$e") $e"; done > "$RUN/errors.txt"
fi
decode_err() { # text -> the text with the first custom error named
  local sel name
  sel=$(grep -oE 'data: "0x[0-9a-fA-F]{8}' <<<"$1" | head -1 | sed 's/data: "//')
  [ -z "$sel" ] && sel=$(grep -oE 'custom error (0x)?[0-9a-fA-F]{8}' <<<"$1" | head -1 | grep -oE '[0-9a-fA-F]{8}$' | sed 's/^/0x/')
  name=$([ -n "$sel" ] && awk -v s="$(tr 'A-F' 'a-f' <<<"$sel")" '$1==s{print $2}' "$RUN/errors.txt")
  if [ -n "$name" ]; then echo "$name"; else grep -oE 'execution reverted[^,]*(, data: "0x[0-9a-fA-F]{0,72})?|MSIG: [a-z ]+|SINK: [a-z ]+' <<<"$1" | head -1; fi
}
# why a call from FROM would revert (eth_call, nothing is sent): names the hub's own error even
# when the real transaction goes through the multisig, which only reports "MSIG: call failed"
why() { # from to sig args...
  local from=$1; shift
  local out
  if out=$(cast call --from "$from" "$@" --rpc-url "$RPC" 2>&1); then echo "(would succeed)"; else decode_err "$out"; fi
}
EV=${EV:-/dev/null}

ts()  { date -u +%FT%TZ; }
log() { printf '%s\n' "$*" | tee -a "$EV" >&2; }
section() { log ""; log "## $* ($(ts), block $(bn))"; }
bn()  { local n; for _ in 1 2 3 4 5; do n=$(cast block-number --rpc-url "$RPC" 2>/dev/null) && { echo "$n"; return; }; sleep 2; done; echo -1; }
wait_block() { # wait until head >= $1
  local target=$1 h
  while :; do h=$(bn); [ "$h" -ge "$target" ] && return 0; sleep 2; done
}
# name an address in logs
label() {
  perl -pe 'BEGIN{ open F, "<", "'"$RUN"'/labels.txt" and do { while(<F>){chomp; my($a,$l)=split; $m{lc $a}=$l if $a} } }
    s/0x([0-9a-fA-F]{40})(?![0-9a-fA-F])/exists $m{lc "0x$1"} ? $m{lc "0x$1"}."(0x".substr($1,0,6)."..)" : "0x$1"/ge'
}
fmx()  { cast from-wei "$1" 2>/dev/null || echo "$1"; }
wsub() { python3 -c "print(int('$1') - int('$2'))"; }   # wei amounts overflow shell arithmetic
bal()  { cast balance "$1" --rpc-url "$RPC"; }
call() { cast call "$@" --rpc-url "$RPC"; }

# send PK TO SIG ARGS... [--value X]: prints "tx=<hash> block=<n> status=<1|0>"; retries on RPC errors
send() {
  local pk=$1; shift
  local out i
  for i in 1 2 3; do
    if out=$(cast send --private-key "$pk" --rpc-url "$RPC" --gas-price 2gwei --priority-gas-price $TIP --json "$@" 2>&1); then
      echo "tx=$(jq -r .transactionHash <<<"$out") block=$(cast to-dec "$(jq -r .blockNumber <<<"$out")") status=$(cast to-dec "$(jq -r .status <<<"$out")") gas=$(cast to-dec "$(jq -r .gasUsed <<<"$out")")"
      return 0
    fi
    case "$out" in *revert*|*"execution reverted"*|*"custom error"*|*Error\(*) echo "REVERTED: $(decode_err "$out")"; return 1;; esac
    sleep 3
  done
  echo "SEND FAILED: $(tr '\n' ' ' <<<"$out" | cut -c1-300)"; return 1
}
# expect a revert: logs the decoded reason; fails the check if it went through
expect_revert() { # what pk to sig args...
  local what=$1; shift
  local r
  if r=$(send "$@"); then log "  FAIL: $what went through: $r"; FAILS=$((FAILS + 1))
  elif [ "${r#REVERTED: }" != "$r" ]; then log "  ok: $what refused: $r"
  else log "  FAIL: $what did not reach the hub: $r"; FAILS=$((FAILS + 1)); fi
}
FAILS=${FAILS:-0}
check() { # description, condition command...
  local d=$1; shift
  if "$@"; then log "  ok: $d"; else log "  FAIL: $d"; FAILS=$((FAILS + 1)); fi
}
eq() { [ "$1" = "$2" ]; }

# multisig (2 of 3): OWNER1 submits (auto-confirms), OWNER2 confirms and executes
msig() { # target value calldata -> prints the execute result
  local target=$1 value=$2 data=$3 id r
  id=$(call "$MSIG" "transactionCount()(uint256)" | awk '{print $1}')
  r=$(send "$OWNER1_PK" "$MSIG" "submit(address,uint256,bytes)" "$target" "$value" "$data") || { echo "submit: $r"; return 1; }
  log "    msig submit #$id by OWNER1: $r"
  r=$(send "$OWNER2_PK" "$MSIG" "confirm(uint256)" "$id") || { echo "confirm: $r"; return 1; }
  log "    msig confirm #$id by OWNER2: $r"
  send "$OWNER2_PK" "$MSIG" "execute(uint256)" "$id"
}

# hub reads
seat() { # id -> lens seat tuple (decoded)
  call "$LENS" "seat(uint256)((address,address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint8,bool,bool,uint8,bool))" "$1" 2>/dev/null || echo "?"
}
seat_status() { # id -> STATUS name via lens seatStatus if present
  call "$LENS" "seatStatus(uint256)(uint8)" "$1" 2>/dev/null || echo "?"
}
checkpoint() { call "$HUB" "checkpoint(uint256)((bytes32,uint32,uint32,uint32,uint40,bool))" "$1"; }
pool() { call "$HUB" "rewardPool()(uint256)" | awk '{print $1}'; }

# per-machine sidecar access
vdir() { # machine[/sN] -> data dir inside the container
  case $1 in h[0-9]/s*) echo "/var/lib/fmx-validator/${1#*/}";; *) echo /var/lib/fmx-validator;; esac
}
vcont() { echo "fmxd-${1%%/*}"; }
vx() { # machine[/sN] fmx-validator args...
  local m=$1; shift
  docker exec "$(vcont "$m")" fmx-validator "$@" --network devnet --data-dir "$(vdir "$m")"
}
vstatus() { vx "$1" status --json 2>/dev/null; }
vlog() { docker exec "$(vcont "$1")" sh -c "cat $(vdir "$1")/devnet/logs/fmx-validator.log 2>/dev/null"; }
attester_of() { docker exec "$(vcont "$1")" jq -r '.address' "$(vdir "$1")/devnet/keys/attester.json" | sed 's/^\(0x\)\{0,1\}/0x/'; }
