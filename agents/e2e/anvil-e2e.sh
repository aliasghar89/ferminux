#!/usr/bin/env bash
# Ferminux Agent Network — end-to-end smoke test against a local anvil chain.
#
# Prerequisites (NOT started by this script):
#   - anvil running at http://127.0.0.1:8545, chain id 3961
#   - AgentRegistry + ServiceEscrow already deployed on it
#
# Usage:
#   REGISTRY=0x... ESCROW=0x... agents/e2e/anvil-e2e.sh
#
# What it does:
#   1. Builds gateway/sdk/runtime if dist/ is missing.
#   2. Starts the gateway on :8790 against a temp DATA_DIR, DEPLOY_BLOCK=0.
#   3. Registers an echo agent with anvil key #1 (endpoint :8801, price 1 FMX, bond 100 FMX)
#      via `ferminux-agent register`.
#   4. Starts `ferminux-agent serve --handler echo` on :8801.
#   5. Hires the agent with anvil key #0 via `ferminux hire` and asserts the
#      output contains "echo:".
#   6. Asserts GET /api/agents/:id shows online:true and jobsCompleted>=1.
#   7. Withdraws credits with key #1 and asserts the wallet balance grew.
#
# Background processes are always cleaned up on exit (trap).

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_ROOT="$(cd "$HERE/.." && pwd)"

GATEWAY_JS="$AGENTS_ROOT/gateway/dist/server.js"
SDK_CLI="$AGENTS_ROOT/sdk/dist/cli.js"
RUNTIME_CLI="$AGENTS_ROOT/runtime/dist/cli.js"

: "${REGISTRY:?set REGISTRY to the deployed AgentRegistry address}"
: "${ESCROW:?set ESCROW to the deployed ServiceEscrow address}"

RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
GATEWAY_PORT="${GATEWAY_PORT:-8790}"
AGENT_PORT="${AGENT_PORT:-8801}"
GATEWAY_URL="http://127.0.0.1:${GATEWAY_PORT}/api"

# Default anvil dev keys #0 (client) and #1 (agent owner).
CLIENT_KEY="${CLIENT_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
AGENT_KEY="${AGENT_KEY:-0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d}"

DATA_DIR="$(mktemp -d /tmp/fmx-e2e.XXXXXX)"
GATEWAY_DATA="$DATA_DIR/gateway"
AGENT_DATA="$DATA_DIR/agent"
mkdir -p "$GATEWAY_DATA" "$AGENT_DATA"

PIDS=()
FAIL=0

log()  { echo "[e2e] $*"; }
step() { echo; echo "--- $* ---"; }

cleanup() {
  step "cleanup"
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait_for_http() {
  local url="$1" tries="${2:-60}"
  for ((i = 0; i < tries; i++)); do
    if curl -sf "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}

json_field() {
  # json_field <field-path-as-js-expr> reads JSON from stdin, e.g. json_field 'j.id'
  node -e "
    let d = '';
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', () => {
      try {
        const j = JSON.parse(d);
        console.log($1);
      } catch (e) {
        process.exit(1);
      }
    });
  "
}

# --- build if needed ---
if [ ! -f "$GATEWAY_JS" ] || [ ! -f "$SDK_CLI" ] || [ ! -f "$RUNTIME_CLI" ]; then
  step "building gateway/sdk/runtime"
  (cd "$AGENTS_ROOT" && npm run build --workspace gateway --workspace sdk --workspace runtime)
fi

# --- 1. start gateway ---
step "starting gateway on :$GATEWAY_PORT"
DATA_DIR="$GATEWAY_DATA" PORT="$GATEWAY_PORT" RPC_URL="$RPC_URL" REGISTRY="$REGISTRY" ESCROW="$ESCROW" \
  DEPLOY_BLOCK=0 POLL_MS=1000 PROBE_MS=5000 \
  node "$GATEWAY_JS" >"$DATA_DIR/gateway.log" 2>&1 &
PIDS+=($!)

if wait_for_http "http://127.0.0.1:${GATEWAY_PORT}/api/health"; then
  log "gateway is up"
else
  log "FAIL: gateway did not come up — see $DATA_DIR/gateway.log"
  tail -n 40 "$DATA_DIR/gateway.log" || true
  echo; echo "================ FAIL ================"; exit 1
fi

# --- 2. register echo agent with key #1 ---
step "registering echo agent (owner = anvil key #1)"
REGISTER_OUT=$(
  FERMINUX_PRIVATE_KEY="$AGENT_KEY" FERMINUX_RPC="$RPC_URL" FERMINUX_GATEWAY="$GATEWAY_URL" \
    FERMINUX_REGISTRY="$REGISTRY" FERMINUX_ESCROW="$ESCROW" \
    node "$RUNTIME_CLI" register --name "EchoBot" --endpoint "http://127.0.0.1:${AGENT_PORT}" \
    --price 1 --bond 100 2>&1
)
log "register output: $REGISTER_OUT"
AGENT_ID=$(echo "$REGISTER_OUT" | json_field 'j.id')
if [ -z "${AGENT_ID:-}" ]; then
  log "FAIL: could not parse agent id from register output"
  echo; echo "================ FAIL ================"; exit 1
fi
log "registered agent id = $AGENT_ID"

# --- 3. start ferminux-agent serve --handler echo ---
step "starting agent runtime on :$AGENT_PORT"
FERMINUX_PRIVATE_KEY="$AGENT_KEY" FERMINUX_RPC="$RPC_URL" FERMINUX_GATEWAY="$GATEWAY_URL" \
  FERMINUX_REGISTRY="$REGISTRY" FERMINUX_ESCROW="$ESCROW" DATA_DIR="$AGENT_DATA" \
  AGENT_DESCRIPTION="Echo test agent" AGENT_CAPABILITIES="echo" \
  node "$RUNTIME_CLI" serve --id "$AGENT_ID" --port "$AGENT_PORT" --handler echo \
  >"$DATA_DIR/agent.log" 2>&1 &
PIDS+=($!)

if wait_for_http "http://127.0.0.1:${AGENT_PORT}/.well-known/ferminux-agent.json"; then
  log "agent runtime is up"
else
  log "FAIL: agent runtime did not come up — see $DATA_DIR/agent.log"
  tail -n 40 "$DATA_DIR/agent.log" || true
  echo; echo "================ FAIL ================"; exit 1
fi

# --- 4. hire the agent with key #0 (client) via `ferminux hire` ---
step "hiring agent $AGENT_ID via 'ferminux hire' (client = anvil key #0)"
HIRE_OUT=$(
  FERMINUX_PRIVATE_KEY="$CLIENT_KEY" FERMINUX_RPC="$RPC_URL" FERMINUX_GATEWAY="$GATEWAY_URL" \
    FERMINUX_REGISTRY="$REGISTRY" FERMINUX_ESCROW="$ESCROW" \
    node "$SDK_CLI" hire "$AGENT_ID" "hello ferminux" 2>&1
)
log "hire output: $HIRE_OUT"
if echo "$HIRE_OUT" | grep -q "echo:"; then
  log "OK: hire output contains 'echo:'"
else
  log "FAIL: hire output did not contain 'echo:'"
  FAIL=1
fi

# --- 5. check agent view: online + jobsCompleted ---
step "checking GET /api/agents/$AGENT_ID"
sleep 2
AGENT_VIEW=$(curl -sf "${GATEWAY_URL}/agents/${AGENT_ID}")
CURL_STATUS=$?
log "agent view: $AGENT_VIEW"
if [ $CURL_STATUS -ne 0 ]; then
  log "FAIL: could not fetch agent view"
  FAIL=1
else
  ONLINE_OK=$(echo "$AGENT_VIEW" | json_field "(j.online === true && j.jobsCompleted >= 1) ? 'yes' : 'no'")
  if [ "$ONLINE_OK" = "yes" ]; then
    log "OK: agent online=true and jobsCompleted>=1"
  else
    log "FAIL: agent view did not show online:true and jobsCompleted>=1"
    FAIL=1
  fi
fi

# --- 6. withdraw credits with key #1 and assert balance grew ---
step "withdrawing credits (agent owner = anvil key #1)"
wallet_balance() {
  FERMINUX_PRIVATE_KEY="$AGENT_KEY" FERMINUX_RPC="$RPC_URL" FERMINUX_GATEWAY="$GATEWAY_URL" \
    FERMINUX_REGISTRY="$REGISTRY" FERMINUX_ESCROW="$ESCROW" \
    node "$SDK_CLI" wallet 2>/dev/null | json_field "j.balance.split(' ')[0]"
}

BAL_BEFORE=$(wallet_balance)
log "agent balance before withdraw: ${BAL_BEFORE:-?} FMX"

WITHDRAW_OUT=$(
  FERMINUX_PRIVATE_KEY="$AGENT_KEY" FERMINUX_RPC="$RPC_URL" FERMINUX_GATEWAY="$GATEWAY_URL" \
    FERMINUX_REGISTRY="$REGISTRY" FERMINUX_ESCROW="$ESCROW" \
    node "$SDK_CLI" withdraw 2>&1
)
log "withdraw output: $WITHDRAW_OUT"

BAL_AFTER=$(wallet_balance)
log "agent balance after withdraw: ${BAL_AFTER:-?} FMX"

BAL_GREW=$(node -e "console.log(parseFloat('${BAL_AFTER:-0}') > parseFloat('${BAL_BEFORE:-0}') ? 'yes' : 'no')")
if [ "$BAL_GREW" = "yes" ]; then
  log "OK: balance grew after withdraw"
else
  log "FAIL: balance did not grow after withdraw (before=${BAL_BEFORE:-?} after=${BAL_AFTER:-?})"
  FAIL=1
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "================ PASS ================"
  echo "anvil e2e: all checks passed (agent id=$AGENT_ID)"
  echo "========================================"
  exit 0
else
  echo "================ FAIL ================"
  echo "anvil e2e: one or more checks failed — see log above"
  echo "  gateway log: $DATA_DIR/gateway.log"
  echo "  agent log:   $DATA_DIR/agent.log"
  echo "========================================"
  exit 1
fi
