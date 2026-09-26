#!/usr/bin/env bash
# The PLAN.md 10.1 Step 1 checklist on the devnet, in block order. Resumable: every finished
# step leaves .run/steps/<name>.done, and a rerun skips it. Evidence goes to evidence/*.log.
#
# Real binaries throughout: 3 signers + 1 rpc node + 14 validator machines (net.sh), the
# ValidatorHub/lens/router from script/DeployValidatorsTestnet.s.sol, 36 fmx-validator
# instances. The hub's durations are compiled in blocks (24 h = 12,343 blocks, 7 days =
# 86,400, 14 days = 172,800); the devnet confirms a block every second (the smallest period
# the engine accepts), so the whole checklist takes about 48 hours of wall time. The hub has
# no devnet parameter, so nothing in it is shortened: checkpoints are every 200 blocks and
# certification needs 30 eligible seats, which is why the devnet runs 36 seats.
#
#   driver.sh            run (or resume) every step
#   driver.sh <step>     run one step (for a manual retry)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib.sh"
mkdir -p "$RUN/steps" "$EVD"
ST="$RUN/state.env"; touch "$ST"; . "$ST"
setst() { grep -v "^$1=" "$ST" > "$ST.new" || true; echo "$1=$2" >> "$ST.new"; mv "$ST.new" "$ST"; eval "$1=\$2"; }
HUBJS() { (cd "$HERE" && node hub.mjs "$@" 2>&1 | label); }
# the machine's own dashboard (127.0.0.1 inside it), screenshotted into evidence/dashboards/<name>-*.png
dash() { # machine name
  local m=$1 port=8570
  case $m in h*/s*) port=$((8570 + ${m##*/s}));; esac
  node "$HERE/dashboard-shot.mjs" "$(vcont "$m")" "$port" "$EVD/dashboards" "$2" >/dev/null 2>&1 \
    && log "  dashboard of $m: evidence/dashboards/$2-desktop.png, -phone.png, .txt, -api-status.json" \
    || log "  (dashboard of $m could not be captured)"
}

# machine table: idx machine (seat owner = SEATOWNER<idx>)
MACHINES=(v01 v02 v03 v04 v05 v06 v07 v08 v09 v10
          v11 v12 h1/s1 h1/s2 h1/s3 h1/s4 h1/s5 h1/s6 h1/s7 h1/s8 h1/s9 h1/s10 h1/s11 h2/s1 h2/s2 h2/s3
          h2/s4 h2/s5 h2/s6 h2/s7 h2/s8 h2/s9 h2/s10 h2/s11 h2/s12 h2/s13)
BUCKET1=(1 2 3 4 5 6 7 8 9 10)            # opened at the start: 10 activations in day bucket 1
BATCHA=(11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26)   # after activationsPerDay = 50
BATCHB=(27 28 29 30 31 32 33 34 35 36)    # about 1,200 blocks later
# roles in bucket 1
X=1; S1=2; S2=3; J=4; R=5; X2=6
m_of() { echo "${MACHINES[$(($1 - 1))]}"; }
owner_of() { eval "echo \$SEATOWNER$1"; }
ownerpk_of() { eval "echo \$SEATOWNER${1}_PK"; }
pwfile_of() { echo "$(vdir "$1")/attester-password"; }

labels() {
  {
    for v in DEPLOYER FUNDER SIGNER1 SIGNER2 SIGNER3 OWNER1 OWNER2 OWNER3 REPORTER OUTSIDER MSIG SINK; do echo "$(eval echo \$$v) $v"; done
    [ -n "${HUB:-}" ] && echo "$HUB HUB" && echo "$LENS LENS" && echo "$ROUTER ROUTER"
    for i in $(seq 1 ${#MACHINES[@]}); do echo "$(owner_of "$i") owner-$(m_of "$i" | tr / -)"; done
    [ -s "$RUN/attesters.txt" ] && cat "$RUN/attesters.txt"
    echo "0x000000000000000000000000000000000000dEaD BURN"
  } > "$RUN/labels.txt"
}

step() { # name function
  local name=$1; shift
  [ -f "$RUN/steps/$name.done" ] && return 0
  log "" ; log ">>> step $name ($(ts), block $(bn))"
  if "$@"; then touch "$RUN/steps/$name.done"; log "<<< step $name done (block $(bn), fails so far $FAILS)"; else
    log "!!! STEP FAILED: $name (block $(bn))"; exit 1; fi
}

# ------------------------------------------------------------------ 01 deploy
s_deploy() {
  EV=$EVD/02-deploy.log; : > "$EV"
  section "deploy on chain $(cast chain-id --rpc-url "$RPC") (devnet 39619, never 3961)"
  check "chain id is 39619" eq "$(cast chain-id --rpc-url "$RPC")" 39619
  local o w
  [ "$(bal "$DEPLOYER")" = 0 ] && for w in DEPLOYER OWNER1 OWNER2 OWNER3 REPORTER OUTSIDER; do
    log "  gas money for $w from the funder: $(send "$FUNDER_PK" "$(eval echo \$$w)" --value 100ether)"
  done
  [ "$(cast code "$MSIG" --rpc-url "$RPC")" = 0x ] && check "deployer nonce is 0 (the multisig and sink addresses are precomputed)" eq "$(cast nonce "$DEPLOYER" --rpc-url "$RPC")" 0
  if [ "$(cast code "$MSIG" --rpc-url "$RPC")" = 0x ]; then
  o=$(cd "$REPO/contracts" && forge create src/MinimalMultisig.sol:MinimalMultisig --rpc-url "$RPC" --private-key "$DEPLOYER_PK" \
      --gas-price 2gwei --priority-gas-price $TIP --broadcast --constructor-args "[$OWNER1,$OWNER2,$OWNER3]" 2 2>&1) || { log "$o"; return 1; }
  log "$(grep -E 'Deployed to|Transaction hash' <<<"$o" | label)"
  o=$(cd "$REPO/contracts" && forge create src/FMXRewardSink.sol:FMXRewardSink --rpc-url "$RPC" --private-key "$DEPLOYER_PK" \
      --gas-price 2gwei --priority-gas-price $TIP --broadcast --constructor-args "$MSIG" 2>&1) || { log "$o"; return 1; }
  log "$(grep -E 'Deployed to|Transaction hash' <<<"$o" | label)"
  fi
  check "multisig at the precomputed address (deployer nonce 0), 2 of 3" eq "$(call "$MSIG" 'threshold()(uint256)')" 2
  check "FMXRewardSink at the address compiled into the devnet node (deployer nonce 1)" eq "$(call "$SINK" 'owner()(address)')" "$MSIG"
  log "  sink balance before deploy of the hub (engine block rewards, 50%): $(fmx "$(bal "$SINK")") FMX"
  section "ValidatorHub + lens + router: agents/contracts/script/DeployValidatorsTestnet.s.sol"
  o=$(cd "$REPO/agents/contracts" && OWNER=$MSIG SINK=$SINK RESERVE=$MSIG DENY="$FUNDER,$MSIG,$SINK" WRITE_DEPLOYMENTS=true \
      forge script script/DeployValidatorsTestnet.s.sol --tc DeployValidatorsTestnet --rpc-url "$RPC" --private-key "$DEPLOYER_PK" --with-gas-price 2gwei --priority-gas-price $TIP \
      --broadcast --slow 2>&1) || { log "$o"; return 1; }
  log "$(sed -n '/== Logs ==/,/^$/p' <<<"$o")"
  mv "$REPO/agents/deployments-validators.39619.json" "$RUN/deployments.json"
  cp "$RUN/deployments.json" "$EVD/deployments-validators.39619.json"
  HUB=$(jq -r .validatorHub "$RUN/deployments.json"); LENS=$(jq -r .validatorHubLens "$RUN/deployments.json"); ROUTER=$(jq -r .sinkRouter "$RUN/deployments.json")
  labels
  section "hub parameters as deployed"
  for f in "owner()(address)" "rewardSink()(address)" "maxSeats()(uint256)" "rewardPerAttest()(uint256)" "currentRewardPerAttest()(uint256)" \
           "activationsPerDay()(uint256)" "deployBlock()(uint256)" "vetoSunsetBlock()(uint256)" "rewardPool()(uint256)" "domainSeparator()(bytes32)" \
           "SEAT_DEPOSIT()(uint256)"; do
    log "  ${f%%(*}: $(call "$HUB" "$f" | label)"
  done
  for a in FUNDER MSIG SINK; do log "  denied[$a]: $(call "$HUB" 'denied(address)(bool)' "$(eval echo \$$a)")"; done
  check "hub owner is the devnet multisig" eq "$(call "$HUB" 'owner()(address)')" "$MSIG"
  check "hub pays surplus back to the sink" eq "$(call "$HUB" 'rewardSink()(address)')" "$SINK"
  check "router owner is the multisig" eq "$(call "$ROUTER" 'owner()(address)')" "$MSIG"
  check "lens reads this hub" eq "$(call "$LENS" 'hub()(address)')" "$HUB"
  check "hub code is PUSH0-free (paris)" eq "$(cast code "$HUB" --rpc-url "$RPC" | cast disassemble 2>/dev/null | grep -c PUSH0)" 0
  log "  hub runtime size: $(( ($(cast code "$HUB" --rpc-url "$RPC" | wc -c) - 3) / 2 )) bytes"
}

# ------------------------------------------------------------------ 02 timelock: 50 activations a day
s_timelock_queue() {
  EV=$EVD/03-timelock.log; : > "$EV"
  section "the multisig queues activationsPerDay = 50 (48 h timelock = 24,686 blocks)"
  log "  $(msig "$HUB" 0 "$(cast calldata 'queueParam(uint8,uint256)' 2 50)")"
  local eta; eta=$(call "$HUB" 'timelockEta(bytes32)(uint256)' "$(cast keccak "$(cast abi-encode 'f(uint8,uint256)' 2 50)")" | awk '{print $1}')
  setst APD_ETA "$eta"
  log "  eta block $eta (queued at $(bn))"
  log "  apply now (must fail: TooEarly):"
  if r=$(msig "$HUB" 0 "$(cast calldata 'applyParam(uint8,uint256)' 2 50)"); then log "  FAIL: applied early: $r"; FAILS=$((FAILS+1)); else log "  ok: refused: $r (the hub's reason, simulated from the multisig: $(why "$MSIG" "$HUB" 'applyParam(uint8,uint256)' 2 50))"; fi
  check "activationsPerDay still 10" eq "$(call "$HUB" 'activationsPerDay()(uint256)')" 10
}

# ------------------------------------------------------------------ 03 funding
s_fund() {
  EV=$EVD/02-deploy.log
  section "the funder (premine wallet) sends each seat owner 2,001 FMX and tops the sink up for the 20,000 FMX tranche"
  local i r
  for i in $(seq 1 ${#MACHINES[@]}); do
    r=$(send "$FUNDER_PK" "$(owner_of "$i")" --value 2001ether) || { log "  $r"; return 1; }
  done
  log "  $i seat owners funded (last: $r)"
  r=$(send "$FUNDER_PK" "$SINK" --value 12000ether) || { log "  $r"; return 1; }
  log "  sink top-up 12,000 FMX: $r; sink balance now $(fmx "$(bal "$SINK")") FMX"
}

# ------------------------------------------------------------------ 04 validator machines
s_machines() {
  EV=$EVD/01-network.log
  section "validator machines: 12 with a supervised node, 2 hosts with 11 and 13 instances over IPC"
  HUB=$HUB "$HERE/net.sh" validators 2>&1 | tee -a "$EV"
  local t=0 ok
  while [ $t -lt 600 ]; do
    ok=0
    for m in "${MACHINES[@]}"; do
      docker exec "$(vcont "$m")" test -s "$(vdir "$m")/devnet/keys/attester.json" 2>/dev/null && ok=$((ok+1))
    done
    [ $ok -eq ${#MACHINES[@]} ] && break
    sleep 10; t=$((t+10))
  done
  log "  attester keys present: $ok / ${#MACHINES[@]}"
  [ "$ok" -eq ${#MACHINES[@]} ] || return 1
  : > "$RUN/attesters.txt"
  for m in "${MACHINES[@]}"; do echo "$(attester_of "$m") att-$(tr / - <<<"$m")" >> "$RUN/attesters.txt"; done
  labels
  sleep 30
  section "every machine: peers, head, status (no seat yet)"
  for n in sig1 sig2 sig3 rpc; do log "  $n: $(docker exec fmxd-$n ferminux attach --exec 'eth.blockNumber + " peers=" + net.peerCount' /data/ferminux.ipc 2>/dev/null)"; done
  for m in v01 v07 h1/s1 h2/s13; do
    log "  --- fmx-validator status on $m:"
    vx "$m" status 2>&1 | label | sed 's/^/    /' | tee -a "$EV" >/dev/null
  done
}

# ------------------------------------------------------------------ seats
open_seat() { # idx
  local i=$1 m pf nk proof att data r
  m=$(m_of "$i"); pf=$(pwfile_of "$m")
  nk=(); case $m in h*) nk=(--nodekey /data/ferminux-geth/nodekey);; esac
  proof=$(vx "$m" seat-proof --owner "$(owner_of "$i")" --password-file "$pf" --json "${nk[@]}" 2>&1) || { log "  seat-proof on $m failed: $proof"; return 1; }
  att=$(jq -r .attester <<<"$proof"); data=$(jq -r .calldata <<<"$proof")
  r=$(send "$FUNDER_PK" "$att" --value 1ether) || { log "  gas for $att: $r"; return 1; }
  r=$(send "$(ownerpk_of "$i")" "$HUB" "$data" --value 2000ether) || { log "  openSeat from $m owner: $r"; return 1; }
  local id; id=$(call "$HUB" 'seatCount()(uint256)')
  log "  seat $id  machine $m  owner $(owner_of "$i" | label)  attester $(label <<<"$att")  enode $(jq -r .enodePubkey <<<"$proof" | cut -c1-18)..  openSeat $r"
  echo "$id $m" >> "$RUN/seatmap.txt"
}
s_seats_b1() {
  EV=$EVD/04-seats.log; : > "$EV"; : > "$RUN/seatmap.txt"
  section "refused deposits"
  expect_revert "openSeat from a premine wallet on the deny list" "$FUNDER_PK" "$HUB" "openSeat(address,bytes,bytes,bytes)" "$OUTSIDER" 0x 0x 0x --value 2000ether
  expect_revert "openSeat with 1,999 FMX" "$(ownerpk_of 36)" "$HUB" "openSeat(address,bytes,bytes,bytes)" "$OUTSIDER" 0x 0x 0x --value 1999ether
  section "bucket 1: ten seats opened now (the 10-a-day churn limit)"
  local i
  for i in "${BUCKET1[@]}"; do open_seat "$i" || return 1; done
  HUBJS seats | tee -a "$EV" >/dev/null
  expect_revert "openSeat reusing an attester key that already holds a seat (KeyUsed)" \
    "$(ownerpk_of 36)" "$HUB" "$(vx v07 seat-proof --owner "$(owner_of 36)" --password-file "$(pwfile_of v07)" --json | jq -r .calldata)" --value 2000ether
  setst ACT1 "$(HUBJS seat 2 | jq -r .activationBlock)"
  log "  bucket 1 activates from block $ACT1 (seat 2)"
}

# ------------------------------------------------------------------ exit while pending (the long unbond starts here)
s_exit_x() {
  EV=$EVD/13-exit-unbond.log; : > "$EV"
  section "seat $X ($(m_of $X)): the owner exits before activation; the 14-day unbond (172,800 blocks) starts now"
  log "  requestExit: $(send "$(ownerpk_of $X)" "$HUB" 'requestExit(uint256)' $X)"
  local s; s=$(HUBJS seat $X); log "$s"
  setst X_UNBOND "$(jq -r .unbondEndBlock <<<"$s")"
  check "seat $X is EXITING with unbondEnd = request block + 172,800" eq "$(jq -r .state <<<"$s")" EXITING
  expect_revert "withdraw before the unbond ends" "$(ownerpk_of $X)" "$HUB" 'withdraw(uint256,address)' $X "$(owner_of $X)"
  expect_revert "withdraw by someone else" "$OUTSIDER_PK" "$HUB" 'withdraw(uint256,address)' $X "$OUTSIDER"
  check "occupiedSeats back to 9" eq "$(call "$HUB" 'occupiedSeats()(uint256)')" 9
}

# ------------------------------------------------------------------ activation
s_activation() {
  EV=$EVD/05-activation.log; : > "$EV"
  section "before activation (seat 2 activates at $ACT1)"
  HUBJS seats | tee -a "$EV" >/dev/null
  for m in v02 v05; do log "  --- $m:"; vx "$m" status 2>&1 | label | sed 's/^/    /' | tee -a "$EV" >/dev/null; done
  local first=$(( (ACT1 / 200 + 1) * 200 ))
  setst CP1 "$first"
  log "  first checkpoint after activation: $first (window $((first+64))..$((first+250)))"
  wait_block $((first + 251))
  section "after the first checkpoint window closed"
  HUBJS seats | tee -a "$EV" >/dev/null
  HUBJS attestations "$ACT1" | tee -a "$EV" >/dev/null
  for m in v02 v05; do log "  --- $m:"; vx "$m" status 2>&1 | label | sed 's/^/    /' | tee -a "$EV" >/dev/null; done
  local n; n=$(HUBJS attestations "$ACT1" | grep -c "^h $first ")
  check "9 active seats (2-10) attested checkpoint $first, each inside [h+64, h+250]" eq "$n" 9
  dash v07 v07-attesting-empty-pool
}

# ------------------------------------------------------------------ empty pool
s_empty_pool() {
  EV=$EVD/06-empty-pool.log; : > "$EV"
  section "empty pool: checkpoints $CP1 and $((CP1+200)) before any funding"
  wait_block $((CP1 + 451))
  log "  rewardPool = $(fmx "$(pool)") FMX, totalFunded = 0"
  HUBJS cps "$CP1" $((CP1 + 200)) | tee -a "$EV" >/dev/null
  HUBJS attestations "$ACT1" | tee -a "$EV" >/dev/null
  check "every attestation so far counted with reward 0" eq "$(HUBJS attestations "$ACT1" | grep -vc 'reward 0.0 ')" 0
  log "  --- v07 dashboard state with an empty pool (fmx-validator status --json, rewards):"
  vstatus v07 | jq '{phase: .phase.title, rewards}' 2>&1 | tee -a "$EV" >/dev/null
  vx v07 status 2>&1 | sed 's/^/    /' | tee -a "$EV" >/dev/null
  section "partial funding: 0.11 FMX (4 rewards of 0.025 and 0.01 left over)"
  log "  fund: $(send "$FUNDER_PK" "$HUB" 'fund()' --value 0.11ether)"
  local h=$((CP1 + 400))
  wait_block $((h + 251))
  HUBJS cps "$h" "$h" | tee -a "$EV" >/dev/null
  HUBJS attestations "$h" | grep "^h $h " | tee -a "$EV" >/dev/null
  local paid; paid=$(HUBJS attestations "$h" | grep "^h $h " | grep -vc 'reward 0.0 ')
  check "exactly 4 attestations at $h were paid (the pool covered 4 x 0.025)" eq "$paid" 4
  check "the rest counted with reward 0 (fail-closed: 0.01 FMX is never paid as a partial reward)" eq "$(fmx "$(pool)")" 0.010000000000000000
  setst CP_PARTIAL "$h"
  section "the published tranche: the multisig withdraws 20,000 FMX from FMXRewardSink to the hub (the mainnet step)"
  log "  sink balance $(fmx "$(bal "$SINK")") FMX"
  log "  $(msig "$SINK" 0 "$(cast calldata 'withdraw(address,uint256)' "$HUB" 20000000000000000000000)")"
  log "  rewardPool = $(fmx "$(pool)") FMX"
  check "pool = 20,000.01 FMX" eq "$(fmx "$(pool)")" 20000.010000000000000000
  h=$((h + 200)); wait_block $((h + 251))
  HUBJS attestations "$h" | grep "^h $h " | tee -a "$EV" >/dev/null
  check "every attestation at $h paid 0.025 FMX" eq "$(HUBJS attestations "$h" | grep "^h $h " | grep -vc 'reward 0.025 ')" 0
  setst CP_PAID "$h"
}

# ------------------------------------------------------------------ jail target: stop J's machine after its first attestation
s_stop_j() {
  EV=$EVD/12-jail-unjail.log; : > "$EV"
  section "seat $J ($(m_of $J)): its machine is switched off after its first attestations (no deposit loss for downtime)"
  HUBJS seat $J | tee -a "$EV" >/dev/null
  docker stop -t 30 "$(vcont "$(m_of $J)")" >/dev/null
  log "  $(m_of $J) stopped at block $(bn)"
}

# ------------------------------------------------------------------ slashing: double attestation, execute and veto
double_attest() { # seat -> proposes a slash; prints slash id
  local id=$1 m h line tx input sigA hashA hashB ks pf sigB
  m=$(m_of "$id")
  line=$(HUBJS attestations "$ACT1" | awk -v s="$id" '$4==s' | tail -1)
  h=$(awk '{print $2}' <<<"$line"); tx=$(awk '{print $NF}' <<<"$line")
  input=$(cast tx "$tx" input --rpc-url "$RPC")
  hashA=$(cast calldata-decode 'attest(uint64,bytes32,bytes)' "$input" | sed -n 2p)
  sigA=$(cast calldata-decode 'attest(uint64,bytes32,bytes)' "$input" | sed -n 3p)
  log "  seat $id ($m) attested h=$h hash=$hashA on-chain (tx $tx, signed by its sidecar)"
  ks=$RUN/ks-$id.json; pf=$RUN/pw-$id
  docker exec "$(vcont "$m")" cat "$(vdir "$m")/devnet/keys/attester.json" > "$ks"
  docker exec "$(vcont "$m")" cat "$(pwfile_of "$m")" > "$pf"; chmod 600 "$ks" "$pf"
  hashB=$(cast keccak "devnet drill: a different block at height $h")
  sigB=$(node "$HERE/sign.mjs" attest "$ks" "$pf" 39619 "$HUB" "$h" "$hashB" | jq -r .sig)
  log "  manual second signature by the same attester key for h=$h over a different hash $hashB"
  log "  (what a second machine on another fork would sign; the sidecar itself refuses: see 08/09)"
  log "  proveDoubleAttestation by REPORTER: $(send "$REPORTER_PK" "$HUB" 'proveDoubleAttestation(uint64,bytes32,bytes,bytes32,bytes)' "$h" "$hashA" "$sigA" "$hashB" "$sigB")"
  expect_revert "the same evidence a second time" "$OUTSIDER_PK" "$HUB" 'proveDoubleAttestation(uint64,bytes32,bytes,bytes32,bytes)' "$h" "$hashA" "$sigA" "$hashB" "$sigB"
}
s_slash() {
  EV=$EVD/11-slash-veto.log; : > "$EV"
  section "double attestation by seat $S1 ($(m_of $S1)) -> slash 1"
  double_attest $S1
  HUBJS slash 1 | tee -a "$EV" >/dev/null
  setst SLASH1_EXEC "$(HUBJS slash 1 | jq -r .executableBlock)"
  HUBJS seat $S1 | tee -a "$EV" >/dev/null
  check "seat $S1 ejected into unbonding at once" eq "$(HUBJS seat $S1 | jq -r .state)" EXITING
  expect_revert "executeSlash inside the 48 h window" "$OUTSIDER_PK" "$HUB" 'executeSlash(uint256)' 1
  expect_revert "veto by anyone but the multisig" "$OWNER1_PK" "$HUB" 'veto(uint256)' 1
  section "double attestation by seat $S2 ($(m_of $S2)) -> slash 2, vetoed by the multisig inside the window"
  double_attest $S2
  log "  veto(2) through the multisig: $(msig "$HUB" 0 "$(cast calldata 'veto(uint256)' 2)")"
  HUBJS slash 2 | tee -a "$EV" >/dev/null
  check "slash 2 VETOED" eq "$(HUBJS slash 2 | jq -r .status)" VETOED
  HUBJS seat $S2 | tee -a "$EV" >/dev/null
  check "vetoed seat keeps its full deposit (stays in its unbond)" eq "$(HUBJS seat $S2 | jq -r .deposit)" 2000.0
  expect_revert "executing a vetoed slash" "$OUTSIDER_PK" "$HUB" 'executeSlash(uint256)' 2
  HUBJS events "$(bn | awk '{print $1-200}')" | grep -E "Slash|ExitRequested" | tee -a "$EV" >/dev/null
  dash "$(m_of $S1)" v02-slashed-unbonding
  log "  --- $(m_of $S1) sidecar after the slash (its key is banned; it signs nothing more):"
  vx "$(m_of $S1)" status 2>&1 | label | sed 's/^/    /' | tee -a "$EV" >/dev/null
}

# ------------------------------------------------------------------ attestations that must revert (10.1 item 7)
s_bad() {
  EV=$EVD/10-bad-attestations.log; : > "$EV"
  local m=v07 id=7 ks=$RUN/ks-7.json pf=$RUN/pw-7 h hh s r
  docker exec fmxd-v07 cat /var/lib/fmx-validator/devnet/keys/attester.json > "$ks"
  docker exec fmxd-v07 cat /var/lib/fmx-validator/attester-password > "$pf"; chmod 600 "$ks" "$pf"
  local head; head=$(bn)
  h=$(( (head - 64) / 200 * 200 ))
  if [ $((head - h)) -gt 230 ]; then h=$((h + 200)); wait_block $((h + 66)); head=$(bn); fi
  section "manual attestations with seat $id's own key ($m) around checkpoint $h (head $head)"
  hh=$(cast block "$h" --field hash --rpc-url "$RPC")
  s=$(node "$HERE/sign.mjs" attest "$ks" "$pf" 39619 "$HUB" "$h" "0x$(printf '%064x' 7)" | jq -r .sig)
  expect_revert "wrong block hash (blockhash(h) is checked on-chain)" "$OUTSIDER_PK" "$HUB" 'attest(uint64,bytes32,bytes)' "$h" "0x$(printf '%064x' 7)" "$s"
  local old=$((h - 400)) oh; oh=$(cast block "$old" --field hash --rpc-url "$RPC")
  s=$(node "$HERE/sign.mjs" attest "$ks" "$pf" 39619 "$HUB" "$old" "$oh" | jq -r .sig)
  expect_revert "a checkpoint whose window closed (h+250 passed)" "$OUTSIDER_PK" "$HUB" 'attest(uint64,bytes32,bytes)' "$old" "$oh" "$s"
  local nc=$((h + 7)) nch; nch=$(cast block "$nc" --field hash --rpc-url "$RPC")
  s=$(node "$HERE/sign.mjs" attest "$ks" "$pf" 39619 "$HUB" "$nc" "$nch" | jq -r .sig)
  expect_revert "a height that is not a multiple of 200" "$OUTSIDER_PK" "$HUB" 'attest(uint64,bytes32,bytes)' "$nc" "$nch" "$s"
  s=$(node "$HERE/sign.mjs" attest "$ks" "$pf" 3961 "$HUB" "$h" "$hh" | jq -r .sig)
  expect_revert "replay of a signature made for chain id 3961 (recovers to an unknown key)" "$OUTSIDER_PK" "$HUB" 'attest(uint64,bytes32,bytes)' "$h" "$hh" "$s"
  s=$(node "$HERE/sign.mjs" attest "$ks" "$pf" 39619 "$LENS" "$h" "$hh" | jq -r .sig)
  expect_revert "replay of a signature made for another hub address" "$OUTSIDER_PK" "$HUB" 'attest(uint64,bytes32,bytes)' "$h" "$hh" "$s"
  local fut=$(( (head / 200 + 1) * 200 ))
  expect_revert "a future checkpoint (not yet 64 deep)" "$OUTSIDER_PK" "$HUB" 'attest(uint64,bytes32,bytes)' "$fut" "$hh" "$s"
  r=$(call "$HUB" 'attested(uint256,uint256)(bool)' $id "$h"); log "  seat $id attested($h) by its sidecar: $r"
}

# ------------------------------------------------------------------ X2: rewards stop at once on exit; claim works
s_exit_x2() {
  EV=$EVD/13-exit-unbond.log
  section "seat $X2 ($(m_of $X2)): claim, then exit after serving; rewards stop at once"
  HUBJS seat $X2 | tee -a "$EV" >/dev/null
  local before claimable; before=$(bal "$(owner_of $X2)"); claimable=$(HUBJS seat $X2 | jq -r .claimable)
  log "  claim: $(send "$(ownerpk_of $X2)" "$HUB" 'claim(uint256,address)' $X2 "$(owner_of $X2)")  (claimable was $claimable FMX)"
  log "  owner balance change: $(fmx "$(wsub "$(bal "$(owner_of $X2)")" "$before")") FMX (claim minus gas)"
  log "  requestExit: $(send "$(ownerpk_of $X2)" "$HUB" 'requestExit(uint256)' $X2)"
  HUBJS seat $X2 | tee -a "$EV" >/dev/null
}
s_exit_x2_check() {
  EV=$EVD/13-exit-unbond.log
  local xb; xb=$(HUBJS events 14000 | awk -v s="seatId=$X2" '$2=="ExitRequested" && $3==s {print $1}' | head -1)
  local head h; head=$(bn); h=$(( (head - 64) / 200 * 200 ))
  if [ $((head - h)) -gt 230 ] || [ "$h" -le "$xb" ]; then h=$(( ((head - 64) / 200 + 1) * 200 )); wait_block $((h + 70)); fi
  section "after the exit (block $xb): seat $X2's key at checkpoint $h"
  log "  seat $X2 lastAttestedHeight $(HUBJS seat $X2 | jq -r .lastAttestedHeight); attested($X2, $h) = $(call "$HUB" 'attested(uint256,uint256)(bool)' $X2 "$h")"
  check "the exited seat's sidecar did not sign checkpoint $h" eq "$(call "$HUB" 'attested(uint256,uint256)(bool)' $X2 "$h")" false
  local ks=$RUN/ks-$X2.json pf=$RUN/pw-$X2 s hh
  docker exec "$(vcont "$(m_of $X2)")" cat "$(vdir "$(m_of $X2)")/devnet/keys/attester.json" > "$ks"
  docker exec "$(vcont "$(m_of $X2)")" cat "$(pwfile_of "$(m_of $X2)")" > "$pf"; chmod 600 "$ks" "$pf"
  hh=$(cast block "$h" --field hash --rpc-url "$RPC")
  s=$(node "$HERE/sign.mjs" attest "$ks" "$pf" 39619 "$HUB" "$h" "$hh" | jq -r .sig)
  expect_revert "an attestation by the exited seat's key at $h (key inactive: no reward, not counted)" "$OUTSIDER_PK" "$HUB" 'attest(uint64,bytes32,bytes)' "$h" "$hh" "$s"
  dash "$(m_of $X2)" v06-exited-unbonding
  log "  --- $(m_of $X2) sidecar after the exit:"
  vx "$(m_of $X2)" status 2>&1 | label | sed 's/^/    /' | tee -a "$EV" >/dev/null
}

# ------------------------------------------------------------------ kill and restart (protection DB)
next_cp() { local head; head=$(bn); echo $(( ((head - 40) / 200 + 1) * 200 )); }
s_restart() {
  EV=$EVD/08-restart-no-double.log; : > "$EV"
  local m; m=$(m_of $R); local c; c=$(vcont "$m")
  local h; h=$(next_cp)
  section "A. seat $R ($m): SIGKILL the whole machine (sidecar and node) the moment the attestation for $h is submitted"
  log "  protection.log before: $(docker exec "$c" sh -c 'wc -l < /var/lib/fmx-validator/devnet/protection.log') lines"
  wait_block $((h + 60))
  local t=0
  until docker exec "$c" grep -q "attestation submitted.*height=$h" /var/lib/fmx-validator/devnet/logs/fmx-validator.log 2>/dev/null; do
    sleep 0.2; t=$((t+1)); [ $t -gt 1500 ] && { log "  no submission seen"; return 1; }
  done
  docker kill -s KILL "$c" >/dev/null; log "  killed at block $(bn) ($(ts))"
  docker exec "$c" true 2>/dev/null || true
  sleep 3; docker start "$c" >/dev/null; log "  started again at block $(bn)"
  wait_block $((h + 251))
  log "  sidecar log around the kill:"
  docker exec "$c" grep -E "height=$h|preflight|starting|protection|torn|watermark" /var/lib/fmx-validator/devnet/logs/fmx-validator.log | tail -15 | label | sed 's/^/    /' | tee -a "$EV" >/dev/null
  log "  protection.log records for $h:"
  docker exec "$c" awk -v h="$h" '$1=="A1" && $5==h' /var/lib/fmx-validator/devnet/protection.log | label | sed 's/^/    /' | tee -a "$EV" >/dev/null
  local n; n=$(HUBJS attestations "$((h))" | grep "^h $h seat $R " | wc -l | tr -d ' ')
  log "  on-chain Attested events for seat $R at $h: $n"
  HUBJS attestations "$h" | grep "^h $h seat $R " | tee -a "$EV" >/dev/null
  check "at most one attestation for seat $R at $h, never two different hashes" test "$n" -le 1
  setst KILL_CP "$h"

  h=$(next_cp)
  section "B. seat $R ($m): the attestation for $h is included, then the service is stopped (SIGTERM) and started again inside the window"
  t=0
  until docker exec "$c" grep -q "attestation included.*height=$h" /var/lib/fmx-validator/devnet/logs/fmx-validator.log 2>/dev/null; do
    sleep 1; t=$((t+1)); [ $t -gt 600 ] && { log "  no inclusion seen"; return 1; }
  done
  log "  included; stopping at block $(bn)"
  docker stop -t 30 "$c" >/dev/null; docker start "$c" >/dev/null; log "  started again at block $(bn)"
  wait_block $((h + 251))
  docker exec "$c" grep -E "height=$h|preflight" /var/lib/fmx-validator/devnet/logs/fmx-validator.log | tail -8 | label | sed 's/^/    /' | tee -a "$EV" >/dev/null
  n=$(HUBJS attestations "$h" | grep -c "^h $h seat $R ")
  check "exactly one attestation for seat $R at $h after the restart" eq "$n" 1
  log "  --- status after both restarts:"
  vx "$m" status 2>&1 | label | sed 's/^/    /' | tee -a "$EV" >/dev/null
}

# ------------------------------------------------------------------ same key on a second machine (10.1 item 4)
s_second_machine() {
  EV=$EVD/09-second-machine.log; : > "$EV"
  local m; m=$(m_of $R); local c; c=$(vcont "$m")
  section "seat $R's attester key copied to a second machine (fmxd-v05b: fresh data dir, empty protection DB, supervised node)"
  docker rm -f fmxd-v05b >/dev/null 2>&1 || true
  docker volume rm fmxd-v05b >/dev/null 2>&1 || true
  . "$RUN/nodekeys.env"
  docker run -d --name fmxd-v05b --hostname v05b --network fmxdev --ip 172.30.39.131 --user 10001:10001 --init \
    -v fmxd-v05b:/var/lib/fmx-validator --entrypoint sleep fmxdev:latest infinity >/dev/null
  docker exec "$c" tar -C /var/lib/fmx-validator -cf - attester-password devnet/keys | docker exec -i fmxd-v05b tar -C /var/lib/fmx-validator -xf -
  local boot; boot=$("$HERE/net.sh" enodes)
  docker exec fmxd-v05b sh -c "
    fmx-validator init --network devnet --chain-id 39619 --data-dir /var/lib/fmx-validator --node-path /usr/local/bin/ferminux --hub $HUB --password-file /var/lib/fmx-validator/attester-password --dashboard 127.0.0.1:8570 >/dev/null &&
    jq '.minPeers = 3 | .node.extraArgs = [\"--bootnodes\",\"$boot\",\"--netrestrict\",\"172.30.39.0/24\"]' /var/lib/fmx-validator/devnet/config.json > /tmp/c && cat /tmp/c > /var/lib/fmx-validator/devnet/config.json &&
    ferminux init --datadir /var/lib/fmx-validator/devnet/node /devnet/genesis.json >/dev/null 2>&1" 2>&1 | tee -a "$EV"
  log "  same attester on both: $(docker exec "$c" jq -r .address /var/lib/fmx-validator/devnet/keys/attester.json) / $(docker exec fmxd-v05b jq -r .address /var/lib/fmx-validator/devnet/keys/attester.json)"
  docker exec -d fmxd-v05b sh -c 'fmx-validator run --network devnet --data-dir /var/lib/fmx-validator > /var/lib/fmx-validator/run.out 2>&1'
  local t=0
  until [ "$(docker exec fmxd-v05b fmx-validator status --json --network devnet --data-dir /var/lib/fmx-validator 2>/dev/null | jq -r '.phase.state // empty')" = stopped ] || [ $t -ge 400 ]; do sleep 10; t=$((t+10)); done
  sleep 20
  log "  waited $t s (block $(bn))"
  log "  second machine output:"
  docker exec fmxd-v05b sh -c 'cat /var/lib/fmx-validator/run.out; tail -20 /var/lib/fmx-validator/devnet/logs/fmx-validator.log 2>/dev/null; echo "--- last-error.txt:"; cat /var/lib/fmx-validator/devnet/last-error.txt 2>/dev/null' | label | sed 's/^/    /' | tee -a "$EV" >/dev/null
  log "  second machine protection.log: $(docker exec fmxd-v05b sh -c 'wc -l < /var/lib/fmx-validator/devnet/protection.log 2>/dev/null || echo absent')"
  check "the second machine signed nothing (no 'attestation submitted')" test "$(docker exec fmxd-v05b grep -c 'attestation submitted' /var/lib/fmx-validator/devnet/logs/fmx-validator.log 2>/dev/null)" = 0
  docker exec fmxd-v05b fmx-validator status --network devnet --data-dir /var/lib/fmx-validator 2>&1 | label | sed 's/^/    /' | tee -a "$EV" >/dev/null
  docker rm -f fmxd-v05b >/dev/null
  log "  second machine removed; the first keeps attesting:"
  local h; h=$(next_cp); wait_block $((h + 251))
  HUBJS attestations "$h" | grep "^h $h seat $R " | tee -a "$EV" >/dev/null
}

# ------------------------------------------------------------------ rewards at the planned rate, claim
s_rewards() {
  EV=$EVD/07-rewards-claim.log; : > "$EV"
  section "rewards: 0.025 FMX per accepted attestation from a funded pool; claim and claimToAttester by the seat owner"
  local id=7 m paid expect cl
  m=$(m_of $id)
  paid=$(HUBJS attestations "$ACT1" | awk -v s=$id '$4==s && $0 !~ /reward 0.0 /' | wc -l | tr -d ' ')
  expect=$(python3 -c "print(f'{$paid*0.025:.3f}')")
  cl=$(HUBJS seat $id | jq -r .claimable)
  HUBJS attestations "$ACT1" | awk -v s=$id '$4==s' | tee -a "$EV" >/dev/null
  log "  seat $id: $paid paid attestations, claimable $cl FMX, expected $expect FMX"
  check "claimable = paid attestations x 0.025" eq "$(python3 -c "print(f'{float(\"$cl\"):.3f}')")" "$expect"
  log "  the planned rate: 0.025 FMX x 61.7 checkpoints a day at 7 s blocks = 1.54 FMX a day (the dashboard's estimate):"
  vstatus "$m" | jq '.rewards' 2>&1 | tee -a "$EV" >/dev/null
  expect_revert "claim by someone other than the seat owner" "$OUTSIDER_PK" "$HUB" 'claim(uint256,address)' $id "$OUTSIDER"
  local before after att; before=$(bal "$OUTSIDER")
  log "  claim to a fresh address: $(send "$(ownerpk_of $id)" "$HUB" 'claim(uint256,address)' $id "$OUTSIDER")"
  after=$(bal "$OUTSIDER")
  check "the recipient received exactly the claimable amount" eq "$(fmx "$(wsub "$after" "$before")")" "$(cast from-wei "$(cast to-wei "$cl")")"
  check "claimable is 0 after the claim" eq "$(HUBJS seat $id | jq -r .claimable)" 0.0
  local h; h=$(next_cp); wait_block $((h + 251))
  att=$(attester_of "$m"); before=$(bal "$att")
  log "  claimToAttester 0.025 (gas top-up): $(send "$(ownerpk_of $id)" "$HUB" 'claimToAttester(uint256,uint256)' $id 25000000000000000)"
  check "the attester key received 0.025 FMX" eq "$(fmx "$(wsub "$(bal "$att")" "$before")")" 0.025000000000000000
  HUBJS events "$((h - 10))" | grep -E "Claimed" | tee -a "$EV" >/dev/null
}

# ------------------------------------------------------------------ jail
s_jail_early() {
  EV=$EVD/12-jail-unjail.log
  section "jail too early: seat $J's 124-checkpoint window is not yet all on duty"
  expect_revert "jail($J) before its duty covers the window" "$OUTSIDER_PK" "$HUB" 'jail(uint256)' $J
  log "  participation($J, 124) = $(call "$HUB" 'participation(uint256,uint256)(uint256)' $J 124)"
}
s_timelock_apply() {
  EV=$EVD/03-timelock.log
  wait_block "$APD_ETA"
  section "apply activationsPerDay = 50 after the timelock (eta $APD_ETA)"
  log "  $(msig "$HUB" 0 "$(cast calldata 'applyParam(uint8,uint256)' 2 50)")"
  check "activationsPerDay = 50" eq "$(call "$HUB" 'activationsPerDay()(uint256)')" 50
}
s_batch_a() {
  EV=$EVD/04-seats.log
  section "batch A: 16 seats (v11, v12, h1 x 11, h2 x 3) in one day bucket"
  local i; for i in "${BATCHA[@]}"; do open_seat "$i" || return 1; done
  setst BATCHA_BLOCK "$(bn)"
  HUBJS seats | tee -a "$EV" >/dev/null
}
s_batch_b() {
  EV=$EVD/04-seats.log
  wait_block $((BATCHA_BLOCK + 1200))
  section "batch B: 10 seats (h2 x 10), about 1,200 blocks after batch A"
  local i; for i in "${BATCHB[@]}"; do open_seat "$i" || return 1; done
  HUBJS seats | tee -a "$EV" >/dev/null
  check "36 seats opened, 32 occupied (2 exited, 2 slashed/unbonding)" eq "$(call "$HUB" 'seatCount()(uint256)') $(call "$HUB" 'occupiedSeats()(uint256)')" "36 32"
}
s_slash_exec() {
  EV=$EVD/11-slash-veto.log
  wait_block "$SLASH1_EXEC"
  section "slash 1 after its 48 h window (executable from $SLASH1_EXEC)"
  log "  a late veto through the multisig: $(msig "$HUB" 0 "$(cast calldata 'veto(uint256)' 1)" 2>&1 || true) (the hub's reason, simulated from the multisig: $(why "$MSIG" "$HUB" 'veto(uint256)' 1))"
  check "slash 1 still pending after the late veto attempt" eq "$(HUBJS slash 1 | jq -r .status)" PENDING
  local burn0 rep0; burn0=$(bal 0x000000000000000000000000000000000000dEaD); rep0=$(bal "$REPORTER")
  log "  executeSlash(1) by an outsider: $(send "$OUTSIDER_PK" "$HUB" 'executeSlash(uint256)' 1)"
  HUBJS slash 1 | tee -a "$EV" >/dev/null
  HUBJS seat $S1 | tee -a "$EV" >/dev/null
  check "seat $S1 deposit 2,000 -> 1,800" eq "$(HUBJS seat $S1 | jq -r .deposit)" 1800.0
  check "180 FMX burned to 0x...dEaD" eq "$(fmx "$(wsub "$(bal 0x000000000000000000000000000000000000dEaD)" "$burn0")")" 180.000000000000000000
  check "reporter credit 20 FMX" eq "$(fmx "$(call "$HUB" 'credits(address)(uint256)' "$REPORTER" | awk '{print $1}')")" 20.000000000000000000
  log "  withdrawCredit: $(send "$REPORTER_PK" "$HUB" 'withdrawCredit(address)' "$REPORTER")"
  log "  reporter balance change: $(fmx "$(wsub "$(bal "$REPORTER")" "$rep0")") FMX (20 minus gas)"
  expect_revert "executing slash 1 twice" "$OUTSIDER_PK" "$HUB" 'executeSlash(uint256)' 1
  HUBJS acct | tee -a "$EV" >/dev/null
}
s_jail() {
  EV=$EVD/12-jail-unjail.log
  local duty; duty=$(HUBJS seat $J | jq -r .dutyStartCp)
  local at=$(( (duty + 123) * 200 + 251 ))
  log "  seat $J duty starts at checkpoint index $duty; the 124-checkpoint window is covered from block $at"
  wait_block $((at + 2))
  section "jail: seat $J attested $(call "$HUB" 'participation(uint256,uint256)(uint256)' $J 124) of the last 124 checkpoints"
  expect_revert "jail($R), a seat that attests every checkpoint" "$OUTSIDER_PK" "$HUB" 'jail(uint256)' $R
  log "  participation($R, 124) = $(call "$HUB" 'participation(uint256,uint256)(uint256)' $R 124)"
  log "  jail($J) by an outsider: $(send "$OUTSIDER_PK" "$HUB" 'jail(uint256)' $J)"
  HUBJS seat $J | tee -a "$EV" >/dev/null
  check "seat $J JAILED, deposit untouched" eq "$(HUBJS seat $J | jq -r '.state + " " + .deposit')" "JAILED 2000.0"
  setst J_UNJAIL "$(HUBJS seat $J | jq -r .unjailBlock)"
  expect_revert "unjail inside the 24 h" "$(ownerpk_of $J)" "$HUB" 'unjail(uint256)' $J
  expect_revert "jail($J) twice" "$OUTSIDER_PK" "$HUB" 'jail(uint256)' $J
  section "the operator switches $(m_of $J) back on while it is jailed: it catches up and shows why it does not sign"
  docker start "$(vcont "$(m_of $J)")" >/dev/null
  local t=0; until [ "$(vstatus "$(m_of $J)" | jq -r '.phase.state // empty')" = jailed ] || [ $t -ge 900 ]; do sleep 10; t=$((t+10)); done
  vx "$(m_of $J)" status 2>&1 | label | sed 's/^/    /' | tee -a "$EV" >/dev/null
  dash "$(m_of $J)" v04-jailed
}
s_unjail() {
  EV=$EVD/12-jail-unjail.log
  wait_block "$J_UNJAIL"
  section "unjail after 24 h (from $J_UNJAIL), machine switched back on"
  expect_revert "unjail by someone other than the owner" "$OUTSIDER_PK" "$HUB" 'unjail(uint256)' $J
  log "  unjail($J) by its owner: $(send "$(ownerpk_of $J)" "$HUB" 'unjail(uint256)' $J)"
  HUBJS seat $J | tee -a "$EV" >/dev/null
  docker start "$(vcont "$(m_of $J)")" >/dev/null 2>&1 || true
  local h; h=$(next_cp); wait_block $((h + 200 + 251))
  HUBJS attestations "$h" | awk -v s=$J '$4==s' | tee -a "$EV" >/dev/null
  check "seat $J attests again after unjail" test "$(HUBJS attestations "$h" | awk -v s=$J '$4==s' | wc -l)" -ge 1
  vx "$(m_of $J)" status 2>&1 | label | sed 's/^/    /' | tee -a "$EV" >/dev/null
  dash "$(m_of $J)" v04-attesting-after-unjail
}

# ------------------------------------------------------------------ certification
cert_report() { # from to
  HUBJS cps "$1" "$2" | tee -a "$EV" >/dev/null
}
s_elig1() {
  EV=$EVD/14-certification.log; : > "$EV"
  local e; e=$(( ACT1 + 86400 + 200 ))
  wait_block $((e + 460))
  section "bucket 1 eligible (7 days after activation): eligibleCount $(call "$HUB" 'eligibleCount()(uint256)')"
  HUBJS events $((ACT1 + 86400 - 10)) | grep SeatEligible | tee -a "$EV" >/dev/null
  cert_report $(( (e / 200) * 200 )) $(( (e / 200) * 200 + 200 ))
}
s_elig_a() {
  EV=$EVD/14-certification.log
  local ea; ea=$(( $(HUBJS seat 11 | jq -r .eligibleFrom) ))
  local eb; eb=$(( $(HUBJS seat 27 | jq -r .eligibleFrom) ))
  setst ELIG_A "$ea"; setst ELIG_B "$eb"
  wait_block $((eb - 5))
  section "batch A eligible from $ea, batch B from $eb: checkpoints in between have eligible = 22 (< 30)"
  HUBJS events $((ea - 10)) | grep SeatEligible | tee -a "$EV" >/dev/null
  cert_report $(( (ea / 200 + 1) * 200 )) $(( ((eb - 251) / 200) * 200 ))
  local bad; bad=$(HUBJS cps $(( (ea / 200 + 1) * 200 )) $(( ((eb - 251) / 200) * 200 )) | grep -c "certified true")
  check "no checkpoint certified while eligible < 30, even with count >= 20" eq "$bad" 0
  check "at least one of those checkpoints had count >= 20" test "$(HUBJS cps $(( (ea / 200 + 1) * 200 )) $(( ((eb - 251) / 200) * 200 )) | awk '{print $4}' | sort -n | tail -1)" -ge 20
}
s_cert() {
  EV=$EVD/14-certification.log
  local first=$(( (ELIG_B / 200 + 1) * 200 ))
  wait_block $((first + 600 + 251))
  section "batch B eligible: eligibleCount $(call "$HUB" 'eligibleCount()(uint256)'); checkpoints from $first"
  HUBJS events $((ELIG_B - 10)) "$((ELIG_B + 400))" | grep SeatEligible | tee -a "$EV" >/dev/null
  cert_report "$first" $((first + 600))
  HUBJS events "$first" | grep CheckpointCertified | tee -a "$EV" >/dev/null
  local hh; hh=$(cast block "$first" --field hash --rpc-url "$RPC")
  check "checkpoint $first certified" eq "$(call "$HUB" 'isCertified(uint256,bytes32)(bool)' "$first" "$hh")" true
  check "isCertified with any other hash is false" eq "$(call "$HUB" 'isCertified(uint256,bytes32)(bool)' "$first" "$(cast keccak x)")" false
  setst CERT_CP "$first"
  log "  --- a sidecar's view (h2/s13):"
  vx h2/s13 status 2>&1 | label | sed 's/^/    /' | tee -a "$EV" >/dev/null
  dash h2/s13 h2-s13-certified
  dash v07 v07-certified
}

# ------------------------------------------------------------------ the explorer against the devnet
s_explorer_cert() {
  EV=$EVD/17-explorer.log
  section "explorer build pointed at the devnet: /validators, seat pages, the certified checkpoint's block page"
  "$HERE/explorer.sh" explorer-2-certified /validators /validators/7 /validators/4 /validators/2 /validators/27 "/block/$CERT_CP" 2>&1 | tee -a "$EV" >/dev/null
}

# ------------------------------------------------------------------ signers halt (10.1 item 9)
s_halt() {
  EV=$EVD/15-signer-halt.log; : > "$EV"
  local h; h=$(next_cp); wait_block $((h + 100))
  section "all three signers stopped for 150 s in the middle of checkpoint $h's window"
  docker stop -t 10 fmxd-sig1 fmxd-sig2 fmxd-sig3 >/dev/null; sleep 5; local b0; b0=$(bn); log "  stopped; head $b0"
  sleep 90
  log "  after 90 s: head $(bn)"
  for m in v07 h1/s1; do log "  --- $m:"; vx "$m" status 2>&1 | label | sed 's/^/    /' | tee -a "$EV" >/dev/null; done
  dash v07 v07-signers-halted
  local c0; c0=$(HUBJS events "$b0" | grep -c CheckpointCertified)
  sleep 60
  check "no block and no certificate while the signers are down" eq "$(bn) $c0" "$b0 0"
  docker start fmxd-sig1 fmxd-sig2 fmxd-sig3 >/dev/null; log "  signers started at $(ts)"
  wait_block $((h + 251 + 200 + 251))
  cert_report "$h" $((h + 200))
  for m in v07; do vx "$m" status 2>&1 | label | sed 's/^/    /' | tee -a "$EV" >/dev/null; done
}

# ------------------------------------------------------------------ final: withdraw after the unbond
s_withdraw() {
  EV=$EVD/13-exit-unbond.log
  wait_block "$X_UNBOND"
  section "seat $X: the 14-day unbond ended at $X_UNBOND"
  local b0; b0=$(bal "$(owner_of $X)")
  log "  withdraw: $(send "$(ownerpk_of $X)" "$HUB" 'withdraw(uint256,address)' $X "$(owner_of $X)")"
  log "  owner balance change: $(fmx "$(wsub "$(bal "$(owner_of $X)")" "$b0")") FMX (2,000 minus gas)"
  HUBJS seat $X | tee -a "$EV" >/dev/null
  check "seat $X WITHDRAWN with deposit 0" eq "$(HUBJS seat $X | jq -r '.state + " " + .deposit')" "WITHDRAWN 0.0"
  sleep 40; dash "$(m_of $X)" v01-seat-closed
  expect_revert "withdraw twice" "$(ownerpk_of $X)" "$HUB" 'withdraw(uint256,address)' $X "$(owner_of $X)"
}
s_final() {
  EV=$EVD/16-final-state.log; : > "$EV"
  section "every attestation of the run: inclusion window and duplicates"
  HUBJS window 0 | tee -a "$EV" >/dev/null
  section "reward and deposit conservation (10.1 item 11)"
  HUBJS acct | tee -a "$EV" >/dev/null
  section "seats"
  HUBJS seats | tee -a "$EV" >/dev/null
  section "protection databases vs the chain: one record per (seat, height), matching the on-chain hash"
  "$HERE/protect-audit.sh" 2>&1 | tee -a "$EV" >/dev/null
}

# ------------------------------------------------------------------ run
ORDER=(deploy:s_deploy timelock:s_timelock_queue fund:s_fund machines:s_machines seats-b1:s_seats_b1 exit-x:s_exit_x
       activation:s_activation stop-j:s_stop_j empty-pool:s_empty_pool slash:s_slash bad:s_bad exit-x2:s_exit_x2
       exit-x2-check:s_exit_x2_check restart:s_restart second:s_second_machine rewards:s_rewards jail-early:s_jail_early timelock-apply:s_timelock_apply
       batch-a:s_batch_a batch-b:s_batch_b slash-exec:s_slash_exec jail:s_jail unjail:s_unjail elig1:s_elig1 elig-a:s_elig_a
       cert:s_cert explorer-cert:s_explorer_cert halt:s_halt withdraw:s_withdraw final:s_final)
if [ "${1:-}" = fn ]; then shift; EV=${EV:-/dev/stderr}; "$@"; exit; fi   # driver.sh fn <function> [args]: manual use
if [ $# -gt 0 ]; then
  for e in "${ORDER[@]}"; do [ "${e%%:*}" = "$1" ] && { rm -f "$RUN/steps/$1.done"; step "$1" "${e#*:}"; exit; }; done
  echo "unknown step $1"; exit 2
fi
for e in "${ORDER[@]}"; do step "${e%%:*}" "${e#*:}"; done
log "ALL STEPS DONE at block $(bn) ($(ts)); checks failed: $FAILS"
