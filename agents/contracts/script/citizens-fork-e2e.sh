#!/usr/bin/env bash
# End-to-end proof of the Ferminux Citizens deploy on a local anvil FORK of chain 3961. Nothing is sent to the
# real chain: every transaction goes to 127.0.0.1, and every sender is impersonated (anvil --auto-impersonate),
# so no key is read or needed.
#
#   agents/contracts/script/citizens-fork-e2e.sh            (from anywhere; needs anvil, forge, cast, jq, node)
#
# 1. deploy with DeployCitizens as the real deployer (community wallet), ids 1..N from tiers.json
# 2. mint one id of every tier at its exact price (and prove a wrong price reverts)
# 3. append a later batch with AppendCitizens as the curator (a copy of tiers.json + 3 test ids)
# 4. the FerminuxAgents owner (the 2-of-3 multisig) accepts ownership: owner 1 submits, owner 2 confirms + executes
# 5. the curator withdraws the proceeds to the treasury
# Prints the gas each step used; OUT (default a temp dir) keeps the broadcast receipts and the summary.
set -euo pipefail
cd "$(dirname "$0")/.."
FORK_RPC=${FORK_RPC:-https://rpc.ferminux.net}
PORT=${PORT:-8599}
RPC=http://127.0.0.1:$PORT
OUT=${OUT:-$(mktemp -d)}
DEPLOYER=${DEPLOYER:-0x34f5366014EF292fd5ff9FFDE81d47819EF65cFC}   # deployed FerminuxAgents (community wallet)
FMXA=0x84FE97C49Ffe4227d9ea139B5998C097D9C06ddd
BUYER=0x00000000000000000000000000000000000B0B01
mkdir -p "$OUT"
# forge may only read/write inside agents/ (foundry.toml fs_permissions): its files go to cache/ (gitignored)
WORK=cache/citizens-e2e
rm -rf "$WORK"; mkdir -p "$WORK"

anvil --fork-url "$FORK_RPC" --chain-id 3961 --port "$PORT" --auto-impersonate --silent &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' EXIT
for _ in $(seq 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
[ "$(cast chain-id --rpc-url "$RPC")" = 3961 ] || { echo "anvil did not start"; exit 1; }
FORK_BLOCK=$(cast block-number --rpc-url "$RPC")
MSIG=$(cast call $FMXA "owner()(address)" --rpc-url "$RPC")
echo "fork of $FORK_RPC at block $FORK_BLOCK; FerminuxAgents owner = $MSIG"

send() { cast send --rpc-url "$RPC" --unlocked --from "$@" --json; }
gas_of() { jq -r '.gasUsed' | cast to-dec; }
lc() { echo "$1" | tr '[:upper:]' '[:lower:]'; }

# ---- 1. deploy ----
had_broadcast=0; [ -d broadcast/DeployCitizens.s.sol/3961 ] && had_broadcast=1
CITIZENS_OUT="$WORK/deployments-citizens.json" forge script script/DeployCitizens.s.sol:DeployCitizens \
  --rpc-url "$RPC" --unlocked --sender "$DEPLOYER" --broadcast --slow --with-gas-price 2gwei --priority-gas-price 1gwei \
  >"$OUT/deploy.log" 2>&1 || { cat "$OUT/deploy.log"; exit 1; }
RUN=broadcast/DeployCitizens.s.sol/3961/run-latest.json
cp "$RUN" "$OUT/deploy-run.json"
cp "$WORK/deployments-citizens.json" "$OUT/"
C=$(jq -r .citizens "$WORK/deployments-citizens.json")
DEPLOY_GAS=$(node -e 'const r=require(process.argv[1]).receipts;console.log(r.reduce((a,x)=>a+BigInt(x.gasUsed),0n).toString())' "$PWD/$RUN")
DEPLOY_TXS=$(jq '.receipts | length' "$RUN")
N=$(cast call "$C" "totalIds()(uint256)" --rpc-url "$RPC")
echo "1. deployed $C: totalIds=$N, $DEPLOY_TXS txs, $DEPLOY_GAS gas"
[ "$(cast call "$C" "pendingOwner()(address)" --rpc-url "$RPC")" = "$MSIG" ] || { echo "pendingOwner is not the FMXA owner"; exit 1; }
[ "$(lc "$(cast call "$C" "owner()(address)" --rpc-url "$RPC")")" = "$(lc "$DEPLOYER")" ] || { echo "owner changed before accept"; exit 1; }
[ "$(cast call "$C" "isCurator(address)(bool)" "$DEPLOYER" --rpc-url "$RPC")" = true ] || { echo "deployer is not curator"; exit 1; }

# ---- 2. one mint per tier ----
cast rpc anvil_setBalance "$BUYER" 0x3635C9ADC5DEA00000 --rpc-url "$RPC" >/dev/null   # 1000 FMX
TIERS_JSON=../nft/citizens/tiers.json
MINT_GAS=""
for tier in Common Rare Epic Legendary; do
  id=$(jq -r --arg t "$tier" '[.tokens[] | select(.tier==$t)][0].id' "$TIERS_JSON")
  p=$(cast call "$C" "price(uint256)(uint256)" "$id" --rpc-url "$RPC" | awk '{print $1}')
  if cast send --rpc-url "$RPC" --unlocked --from "$BUYER" "$C" "mint(uint256)" "$id" --value "$(node -e 'console.log((BigInt(process.argv[1]) - 1n).toString())' "$p")" >/dev/null 2>&1; then
    echo "a mint at price-1 went through for #$id"; exit 1
  fi
  g=$(send "$BUYER" "$C" "mint(uint256)" "$id" --value "$p" | gas_of)
  owner=$(cast call "$C" "ownerOf(uint256)(address)" "$id" --rpc-url "$RPC")
  [ "$(lc "$owner")" = "$(lc "$BUYER")" ] || { echo "#$id not owned by buyer"; exit 1; }
  echo "2. minted #$id ($tier) for $(cast from-wei "$p") FMX, $g gas; wrong price reverted"
  MINT_GAS="$MINT_GAS $g"
done
PROCEEDS=$(cast balance "$C" --rpc-url "$RPC")

# ---- 3. a later batch ----
node -e '
  const fs = require("fs"); const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const n = d.tokens.length;
  ["Legendary", "Common", "Rare"].forEach((tier, i) => d.tokens.push({ ...d.tokens[0], id: n + i + 1, name: "Fork test " + (i + 1), tier, needsReview: false }));
  fs.writeFileSync(process.argv[2], JSON.stringify(d));' "$TIERS_JSON" "$WORK/tiers-plus3.json"
TIERS_JSON="$WORK/tiers-plus3.json" CITIZENS="$C" forge script script/DeployCitizens.s.sol:AppendCitizens \
  --rpc-url "$RPC" --unlocked --sender "$DEPLOYER" --broadcast --with-gas-price 2gwei --priority-gas-price 1gwei \
  >"$OUT/append.log" 2>&1 || { cat "$OUT/append.log"; exit 1; }
APPEND_GAS=$(jq -r '.receipts[0].gasUsed' broadcast/DeployCitizens.s.sol/3961/run-latest.json | cast to-dec)
cp broadcast/DeployCitizens.s.sol/3961/run-latest.json "$OUT/append-run.json"
N2=$(cast call "$C" "totalIds()(uint256)" --rpc-url "$RPC")
NEW=$((N + 1))
[ "$N2" = $((N + 3)) ] || { echo "append: totalIds=$N2"; exit 1; }
[ "$(cast call "$C" "tierOf(uint256)(uint8)" "$NEW" --rpc-url "$RPC")" = 3 ] || { echo "append: tier of #$NEW"; exit 1; }
g=$(send "$BUYER" "$C" "mint(uint256)" $((N + 2)) --value 50ether | gas_of)
echo "3. appended #$NEW-#$N2 as curator ($APPEND_GAS gas); minted #$((N + 2)) from the new batch ($g gas)"

# ---- 4. the multisig accepts ownership ----
OWNERS=$(cast call "$MSIG" "getOwners()(address[])" --rpc-url "$RPC" | tr -d '[] ' | tr ',' ' ')
O1=$(echo "$OWNERS" | awk '{print $1}'); O2=$(echo "$OWNERS" | awk '{print $2}')
for o in $O1 $O2; do cast rpc anvil_setBalance "$o" 0x8AC7230489E80000 --rpc-url "$RPC" >/dev/null; done   # 10 FMX gas
TXID=$(cast call "$MSIG" "transactionCount()(uint256)" --rpc-url "$RPC")
DATA=$(cast calldata "acceptOwnership()")
g1=$(send "$O1" "$MSIG" "submit(address,uint256,bytes)" "$C" 0 "$DATA" | gas_of)
g2=$(send "$O2" "$MSIG" "confirm(uint256)" "$TXID" | gas_of)
g3=$(send "$O2" "$MSIG" "execute(uint256)" "$TXID" | gas_of)
[ "$(cast call "$C" "owner()(address)" --rpc-url "$RPC")" = "$MSIG" ] || { echo "owner is not the multisig"; exit 1; }
[ "$(cast call "$C" "pendingOwner()(address)" --rpc-url "$RPC")" = 0x0000000000000000000000000000000000000000 ] || { echo "pendingOwner not cleared"; exit 1; }
if cast send --rpc-url "$RPC" --unlocked --from "$DEPLOYER" "$C" "pause()" >/dev/null 2>&1; then echo "old owner can still pause"; exit 1; fi
echo "4. multisig tx #$TXID: submit $g1 + confirm $g2 + execute $g3 gas; owner = $MSIG, deployer lost owner rights"

# ---- 5. withdraw ----
TREASURY=$(cast call "$C" "treasury()(address)" --rpc-url "$RPC")
before=$(cast balance "$TREASURY" --rpc-url "$RPC")
gw=$(send "$DEPLOYER" "$C" "withdraw()" | gas_of)
after=$(cast balance "$TREASURY" --rpc-url "$RPC")
got=$(node -e 'console.log((BigInt(process.argv[2]) - BigInt(process.argv[1])).toString())' "$before" "$after")
want=$(node -e 'console.log((BigInt(process.argv[1]) + 50n * 10n ** 18n).toString())' "$PROCEEDS")
[ "$got" = "$want" ] || { echo "treasury got $got, expected $want"; exit 1; }
echo "5. curator withdrew $(cast from-wei "$got") FMX to the treasury $TREASURY ($gw gas)"

# broadcast files of a fork run must not pass for a mainnet deploy: they were copied to $OUT
[ $had_broadcast = 1 ] || { rm -rf broadcast/DeployCitizens.s.sol/3961; rmdir broadcast/DeployCitizens.s.sol 2>/dev/null || true; }
rm -rf "$WORK"
cat >"$OUT/summary.json" <<EOF
{"forkBlock":$FORK_BLOCK,"citizens":"$C","totalIds":$N,"deployTxs":$DEPLOY_TXS,"deployGas":$DEPLOY_GAS,"mintGas":"$(echo $MINT_GAS)","appendGas3":$APPEND_GAS,"acceptGas":[$g1,$g2,$g3],"withdrawGas":$gw}
EOF
echo "PASS — summary in $OUT/summary.json"
