#!/usr/bin/env bash
# Verify Ferminux Network's own contracts on explorer.ferminux.net.
#
# Needs the smart-contract-verifier service to be live behind the explorer (docker-compose.yml,
# envs/verifier.env, MICROSERVICE_SC_VERIFIER_* in envs/backend.env). Run it from a checkout of
# this repo on any machine with forge, python3 and curl. It reads only public data (the chain
# RPC and the explorer API) and uploads source code to the explorer. It needs no keys and sends
# no transactions.
#
#   explorer/scripts/verify-contracts.sh               # pre-flight every contract, then submit
#   explorer/scripts/verify-contracts.sh --check       # pre-flight only, submit nothing
#   explorer/scripts/verify-contracts.sh FerminuxCitizens FerminuxAgents   # only these labels
#
#   EXPLORER_URL (default https://explorer.ferminux.net)
#   RPC_URL      (default https://rpc.ferminux.net)
#
# Pre-flight, per contract: build its foundry project (solc 0.8.24, optimizer 200 runs, evm
# paris, plus each project's own via_ir / metadata settings from its foundry.toml) into a temp
# dir, then compare the build with the chain:
#   - created by a transaction: the on-chain creation input must start with the local creation
#     code. The remainder is the constructor arguments.
#   - created by another contract (no creation transaction in the index, because internal
#     transactions are not indexed): the on-chain runtime code must equal the local runtime
#     code, immutables masked.
# FULL   = byte-identical, including the metadata hash: the source is exactly what was deployed.
# PARTIAL = identical except the metadata hash: the source changed only in comments or
#          whitespace since the deploy. The explorer shows these as partially verified. So is a
#          build with no metadata at all (dex/: cbor_metadata = false): nothing to fully match.
# MISMATCH = the code differs: skipped, and listed at the end.
#
# Submission uses the explorer's Etherscan-compatible API (forge's blockscout verifier). The
# explorer does the real check itself, with the on-chain code; a re-run skips contracts that are
# already verified.

set -euo pipefail

EXPLORER_URL="${EXPLORER_URL:-https://explorer.ferminux.net}"
EXPLORER_URL="${EXPLORER_URL%/}"
RPC_URL="${RPC_URL:-https://rpc.ferminux.net}"
CHAIN_ID=3961
SOLC="v0.8.24+commit.e11b9ed9"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# label | foundry project (from the repo root) | source:Contract | address
# Sources: agents/deployments*.json, explorer/web/src/data/contracts.3961.json, the forge broadcast
# records, and every contract the two deployer accounts created on chain 3961.
CONTRACTS='
FerminuxCitizens        agents/contracts  src/FerminuxCitizens.sol:FerminuxCitizens                    0x5672AF1a567a46BAaFeb66959b7A95666E7f4252
FerminuxAgents          agents/contracts  src/FerminuxAgents.sol:FerminuxAgents                        0x84FE97C49Ffe4227d9ea139B5998C097D9C06ddd
AgentRegistry           agents/contracts  src/AgentRegistry.sol:AgentRegistry                          0xa94f27F18267d09349809f3e2AeF8e7767033e8F
ServiceEscrow           agents/contracts  src/ServiceEscrow.sol:ServiceEscrow                          0x99b331495951dB91857902de91EAe9Ff54d8a719
X402Vault               agents/contracts  src/X402Vault.sol:X402Vault                                  0x8751Cf7e29Fe588c61FDc53323438247198eaa57
AgentAccountFactory     agents/contracts  src/AgentAccountFactory.sol:AgentAccountFactory              0x82e7C593785f726A0A0BB4D37AbCaF2bA4a72dcb
AgentAccount            agents/contracts  src/AgentAccount.sol:AgentAccount                            0xb110021fAFcB541081aDA72da58964BA74c63942
StreamPay               agents/contracts  src/StreamPay.sol:StreamPay                                  0x59404F738A90E5CF725F5837EF40461d1EA2EC35
ArbiterPool             agents/contracts  src/ArbiterPool.sol:ArbiterPool                              0x367312B28f78dE97462905519337841e4d4cB2df
IdentityRegistry8004    agents/contracts  src/erc8004/IdentityRegistry8004.sol:IdentityRegistry8004    0xf3e8c83a0472602d04Cd774e3887cBAA76c62147
ReputationRegistry8004  agents/contracts  src/erc8004/ReputationRegistry8004.sol:ReputationRegistry8004 0xd5984C5a187cD6EcF2698eb218988F73FBF08884
ValidationRegistry8004  agents/contracts  src/erc8004/ValidationRegistry8004.sol:ValidationRegistry8004 0x37feB1B3Fb6505d4D584dB0a632F3C20d9eAab97
AgentTokenFactory       agents/contracts  src/AgentTokenFactory.sol:AgentTokenFactory                  0xf9fcCF337a7930D146227601C1da7Be85bB50188
MinimalMultisig         contracts         src/MinimalMultisig.sol:MinimalMultisig                      0x910BD467D8576277f8f96DF47428377FFD94fEfe
AZNT                    contracts         src/AZNT.sol:AZNT                                            0xFc81ad7c145B868ef0CEC8D7Ec881Ac93f724178
USDF                    contracts         src/USDF.sol:USDF                                            0xCd032A609e34121D1881E8DE7355b2c2c7092363
TokenFactory            contracts         src/TokenFactory.sol:TokenFactory                            0x62BC7d9671EfE1385413434aB8fdfE2fa4aE01D4
Faucet                  contracts         src/Faucet.sol:Faucet                                        0xf4dE70068031DA17347cd19aCaa841013751B3c0
FMXVesting              contracts         src/FMXVesting.sol:FMXVesting                                0x6F488FB1f382Bc96Fef8bBfCa28A9647E5Fe430B
FMXRewardSink           contracts         src/FMXRewardSink.sol:FMXRewardSink                          0x691E5275BF346FfFa0B30174dDBeDfCC078dd8D6
FoundationLock          contracts         src/FoundationLock.sol:FoundationLock                        0xC0E01D9F49eE0967F34e1CB045B74D3Aefac189d
WFMX                    dex/contracts     src/WFMX.sol:WFMX                                            0x8a9Ae4D652cEba09Db8Ebf48D28C943b41B377Ae
FerminuxFactory         dex/contracts     src/FerminuxFactory.sol:FerminuxFactory                      0x2034a8366fCdbfFCf4517D297f702aDDdba37040
FerminuxRouter          dex/contracts     src/FerminuxRouter.sol:FerminuxRouter                        0x018C0Efca293F7a74D2f53ce738BA5e2f412BA9f
LiquidityLocker         dex/contracts     src/LiquidityLocker.sol:LiquidityLocker                      0xe588c594388B978E64B69E2Dd91CC7E302763951
FerminuxPair            dex/contracts     src/FerminuxPair.sol:FerminuxPair                            0xbab12e7B817F0686e11949eC06697235DC146845
FerminuxBridge          bridge/contracts  src/FerminuxBridge.sol:FerminuxBridge                        0x498Bc2c68051ca86B4bE95Eb586f7f18b680CB4e
FerminuxBridge-14714    bridge/contracts  src/FerminuxBridge.sol:FerminuxBridge                        0xe162eeDa683f067d4Ebf61060Fa322332a779EF4
'
# Not covered, on purpose:
#   - contracts created at run time by our factories: AgentAccount clones (minimal proxies; the
#     explorer resolves them to the verified AgentAccount above), agent tokens from
#     AgentTokenFactory, tokens from TokenFactory, and every other FerminuxPair.
#   - staking/, liquidity/ and card/ contracts: not deployed on chain 3961.
#   - bridge contracts on other chains: not this explorer.

CHECK_ONLY=0
ONLY=()
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) ONLY+=("$arg") ;;
  esac
done

for bin in forge python3 curl; do
  command -v "$bin" >/dev/null || { echo "missing: $bin" >&2; exit 1; }
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/fmx-verify.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------------------------------------
# 1. The explorer must offer our compiler. An empty list means the verifier is not reachable
#    from the backend (or MICROSERVICE_SC_VERIFIER_ENABLED is still false).
# ---------------------------------------------------------------------------------------------
echo "== ${EXPLORER_URL}/api/v2/smart-contracts/verification/config"
if curl -fsS --max-time 60 "${EXPLORER_URL}/api/v2/smart-contracts/verification/config" -o "$TMP/config.json" &&
   python3 -c 'import json,sys; sys.exit(0 if sys.argv[2] in json.load(open(sys.argv[1])).get("solidity_compiler_versions",[]) else 1)' "$TMP/config.json" "$SOLC"; then
  echo "   lists ${SOLC}"
else
  echo "   does NOT list ${SOLC}: the verifier is not live behind the explorer." >&2
  if [ "$CHECK_ONLY" -eq 0 ]; then
    echo "   Deploy it first (explorer/README.md, 'Contract verification'); --check still works." >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------------------------
# 2. Pre-flight comparison with the chain (python3 stdlib only).
#    Prints: <FULL|PARTIAL|MISMATCH|NOCODE> <creation|deployed|-> <constructor-args hex|->
# ---------------------------------------------------------------------------------------------
cat > "$TMP/preflight.py" <<'PY'
import json, re, sys, urllib.request

art_path, addr, explorer, rpc_url = sys.argv[1:5]
UA = {"user-agent": "ferminux-verify-contracts"}

def http_json(url, payload=None):
    headers = dict(UA)
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["content-type"] = "application/json"
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers), timeout=60) as r:
        return json.load(r)

def rpc(method, params):
    r = http_json(rpc_url, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    if r.get("error"):
        raise SystemExit(f"rpc {method}: {r['error']}")
    return r["result"]

def hexbody(h):
    h = (h or "").lower()
    return h[2:] if h.startswith("0x") else h

# solc's CBOR metadata tail: {"ipfs": <34 bytes>, "solc": <3 bytes>}, length 0x0033.
META = re.compile(r"a264697066735822[0-9a-f]{68}64736f6c6343[0-9a-f]{6}0033")
def mask(h):
    return META.sub(lambda m: "m" * len(m.group(0)), h)

art = json.load(open(art_path))
creation = hexbody(art["bytecode"]["object"])
runtime_local = hexbody(art["deployedBytecode"]["object"])
immutables = art["deployedBytecode"].get("immutableReferences") or {}

runtime_chain = hexbody(rpc("eth_getCode", [addr, "latest"]))
if not runtime_chain:
    print("NOCODE - -")
    sys.exit(0)

info = http_json(f"{explorer}/api/v2/addresses/{addr}")
tx_hash = info.get("creation_transaction_hash") or info.get("creation_tx_hash")
tx = rpc("eth_getTransactionByHash", [tx_hash]) if tx_hash else None

if tx and tx.get("to") is None:
    inp = hexbody(tx["input"])
    if inp.startswith(creation):
        kind = "FULL"
    elif len(inp) >= len(creation) and mask(inp[:len(creation)]) == mask(creation):
        kind = "PARTIAL"
    else:
        print("MISMATCH creation -")
        sys.exit(0)
    if not META.search(creation):
        kind = "PARTIAL"  # no metadata hash to match: the explorer can only call it partial
    args = inp[len(creation):]
    print(kind, "creation", "0x" + args if args else "-")
else:
    if len(runtime_local) != len(runtime_chain):
        print("MISMATCH deployed -")
        sys.exit(0)
    loc, chn = list(runtime_local), list(runtime_chain)
    for refs in immutables.values():
        for ref in refs:
            s, n = 2 * ref["start"], 2 * ref["length"]
            loc[s:s + n] = "i" * n
            chn[s:s + n] = "i" * n
    loc, chn = "".join(loc), "".join(chn)
    kind = "FULL" if loc == chn else ("PARTIAL" if mask(loc) == mask(chn) else "MISMATCH")
    if kind == "FULL" and not META.search(runtime_local):
        kind = "PARTIAL"
    print(kind, "deployed", "-")
PY

selected() {
  [ "${#ONLY[@]}" -eq 0 ] && return 0
  local want
  for want in ${ONLY[@]+"${ONLY[@]}"}; do [ "$want" = "$1" ] && return 0; done
  return 1
}

build_project() {  # $1 = project dir relative to the repo; builds once into $TMP
  local proj="$1" key
  key="$(printf '%s' "$proj" | tr '/' '_')"
  if [ ! -d "$TMP/build-$key" ]; then
    echo "== forge build ${proj}" >&2
    ( cd "$REPO/$proj" && forge build --root . --out "$TMP/build-$key/out" --cache-path "$TMP/build-$key/cache" \
        --skip test --skip script >"$TMP/build-$key.log" 2>&1 ) || {
      echo "   build failed, see below" >&2; tail -20 "$TMP/build-$key.log" >&2; return 1; }
  fi
  printf '%s\n' "$TMP/build-$key/out"
}

PLAN_LABEL=(); PLAN_PROJ=(); PLAN_TARGET=(); PLAN_ADDR=(); PLAN_ARGS=(); PLAN_KIND=()
SKIPPED=(); DONE=(); FAILED=()
echo
echo "== pre-flight against ${RPC_URL}"
while read -r label proj target addr; do
  [ -n "${label:-}" ] || continue
  selected "$label" || continue
  out="$(build_project "$proj")" || { SKIPPED+=("$label $addr: build of $proj failed"); continue; }
  src="${target%%:*}"; name="${target##*:}"
  artifact="$out/$(basename "$src")/$name.json"
  if [ ! -f "$artifact" ]; then SKIPPED+=("$label $addr: no artifact $artifact"); continue; fi
  res="$(python3 "$TMP/preflight.py" "$artifact" "$addr" "$EXPLORER_URL" "$RPC_URL" 2>"$TMP/preflight.err")" ||
    res="ERROR preflight -"
  read -r kind mode args <<<"$res"
  [ "$kind" = ERROR ] && sed 's/^/     /' "$TMP/preflight.err" | tail -3
  printf '   %-24s %s  %-8s (%s)\n' "$label" "$addr" "$kind" "$mode"
  case "$kind" in
    FULL|PARTIAL)
      PLAN_LABEL+=("$label"); PLAN_PROJ+=("$proj"); PLAN_TARGET+=("$target"); PLAN_ADDR+=("$addr")
      PLAN_ARGS+=("$args"); PLAN_KIND+=("$kind") ;;
    ERROR) SKIPPED+=("$label $addr: pre-flight could not read the chain or the explorer") ;;
    *) SKIPPED+=("$label $addr: $kind ($mode) - the repo source does not build to the on-chain code") ;;
  esac
done <<<"$CONTRACTS"

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo
  echo "== --check: ${#PLAN_LABEL[@]} ready to submit, ${#SKIPPED[@]} skipped"
  for s in "${SKIPPED[@]+"${SKIPPED[@]}"}"; do echo "   skip: $s"; done
  exit 0
fi

# ---------------------------------------------------------------------------------------------
# 3. Submit. forge posts the standard-JSON input to /api (module=contract, action=
#    verifysourcecode) and polls checkverifystatus. The explorer's own verification call has a
#    5-minute timeout; --retries x --delay covers the same window.
# ---------------------------------------------------------------------------------------------
echo
for i in ${PLAN_LABEL[@]+"${!PLAN_LABEL[@]}"}; do
  label="${PLAN_LABEL[$i]}"; proj="${PLAN_PROJ[$i]}"; target="${PLAN_TARGET[$i]}"; addr="${PLAN_ADDR[$i]}"
  args="${PLAN_ARGS[$i]}"
  echo "== verify ${label} ${addr} (${PLAN_KIND[$i]} expected)"
  cmd=(forge verify-contract "$addr" "$target" --root .
       --chain "$CHAIN_ID" --verifier blockscout --verifier-url "${EXPLORER_URL}/api/"
       --compiler-version "$SOLC" --watch --retries 30 --delay 10)
  if [ "$args" != "-" ]; then cmd+=(--constructor-args "$args"); fi
  if ( cd "$REPO/$proj" && "${cmd[@]}" ) >"$TMP/verify-$label.log" 2>&1; then
    grep -E 'already verified|Pass - Verified|Response|Details|GUID' "$TMP/verify-$label.log" | sed 's/^/   /' || true
  else
    sed 's/^/   /' "$TMP/verify-$label.log" | tail -15
    FAILED+=("$label $addr: forge verify-contract failed")
    continue
  fi
  state="$(curl -fsS --max-time 60 "${EXPLORER_URL}/api/v2/smart-contracts/${addr}" 2>/dev/null |
    python3 -c 'import json,sys
d = json.load(sys.stdin)
if d.get("is_fully_verified"): print("verified (full match)")
elif d.get("is_partially_verified"): print("verified (partial match)")
elif d.get("is_verified"): print("verified")
else: print("NOT verified")' 2>/dev/null || echo "unknown (explorer read failed)")"
  echo "   explorer: ${state}"
  case "$state" in
    verified*) DONE+=("$label $addr: $state") ;;
    *) FAILED+=("$label $addr: explorer says $state") ;;
  esac
  sleep 2
done

echo
echo "== summary: ${#DONE[@]} verified, ${#FAILED[@]} failed, ${#SKIPPED[@]} skipped"
for s in "${DONE[@]+"${DONE[@]}"}"; do echo "   ok:   $s"; done
for s in "${FAILED[@]+"${FAILED[@]}"}"; do echo "   FAIL: $s"; done
for s in "${SKIPPED[@]+"${SKIPPED[@]}"}"; do echo "   skip: $s"; done
[ "${#FAILED[@]}" -eq 0 ]
