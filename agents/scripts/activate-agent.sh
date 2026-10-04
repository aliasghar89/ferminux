#!/usr/bin/env bash
# Give a model-backed agent its API key and set it Active on-chain.
#   LLM_API_KEY=… agents/scripts/activate-agent.sh <slug> - [model]      key from the environment
#   agents/scripts/activate-agent.sh <slug> - [model] < key-file          key on stdin (prompted, not echoed, on a terminal)
#   agents/scripts/activate-agent.sh <slug> cli [model]                   subscription mode
# "cli" = subscription mode: leave the key empty and rely on LLM_CLI (log in first with cli-login.sh on the box)
# slug ∈ claude gpt gemini llama mistral grok qwen deepseek scribe
# Secrets never travel as command-line arguments: argv is readable by every user on the machine (ps, /proc). The
# LLM key reaches python through its environment, the agent's private key is read from its file by node, and the
# env file stays 0600. Needs `npm ci` in agents/ (ethers) and FMX_DEPLOY_HOST + FMX_DEPLOY_KEY.
set -euo pipefail
umask 077
SLUG=${1:?usage: activate-agent.sh <slug> <-|cli> [model]}; MODE=${2:?usage: activate-agent.sh <slug> <-|cli> [model]}; MODEL=${3:-}
case "$MODE" in
  cli) KEY="" ;;
  -)
    if [ -n "${LLM_API_KEY:-}" ]; then KEY=$LLM_API_KEY
    elif [ -t 0 ]; then read -rsp "LLM API key for $SLUG: " KEY; echo >&2
    else IFS= read -r KEY || true
    fi
    [ -n "$KEY" ] || { echo "no LLM API key: set LLM_API_KEY or pipe it on stdin" >&2; exit 1; } ;;
  *) echo "refusing a key on the command line (any user can read it with ps): pass '-' with LLM_API_KEY or stdin, or 'cli'" >&2; exit 2 ;;
esac
unset LLM_API_KEY
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
ENV="$ROOT/.credentials/agents/secrets-netcup/agent-$SLUG.env"
[ -f "$ENV" ] || { echo "no $ENV"; exit 1; }
# Deployment target, from the environment only: FMX_DEPLOY_HOST (user@host) and FMX_DEPLOY_KEY (the SSH key) for
# your own infrastructure; FMX_DEPLOY_DIR is where the compose stack lives.
H="${FMX_DEPLOY_HOST:?set FMX_DEPLOY_HOST=user@host}"
DEPLOY_KEY="${FMX_DEPLOY_KEY:?set FMX_DEPLOY_KEY=/path/to/ssh/key}"
SSH="ssh -i $DEPLOY_KEY"
DIR="${FMX_DEPLOY_DIR:-/opt/ferminux/infra/compose}"
chmod 600 "$ENV"
FMX_LLM_KEY="$KEY" python3 - "$ENV" "$MODEL" <<'PY'
import os,sys,re
p,model=sys.argv[1:3]; key=os.environ['FMX_LLM_KEY']; s=open(p).read()
# a function replacement: a key is inserted literally, never read as a regex template
s=re.sub(r'^LLM_API_KEY=.*$', lambda m: 'LLM_API_KEY=' + key, s, flags=re.M)
if model: s=re.sub(r'^LLM_MODEL=.*$', lambda m: 'LLM_MODEL=' + model, s, flags=re.M)
open(p,'w').write(s)
PY
KEY=""
ID=$(cat "$ROOT/.credentials/agents/$SLUG.id")
RSYNC_RSH="$SSH" rsync -az "$ENV" $H:$DIR/secrets/agent-$SLUG.env
$SSH $H "cd $DIR && chmod 600 secrets/agent-$SLUG.env && docker compose -f docker-compose.prod.yml -f docker-compose.servernet.yml -f docker-compose.mesh.yml -f docker-compose.agents.yml -f docker-compose.archive.yml up -d --no-deps --force-recreate agent-$SLUG >/dev/null 2>&1 && docker logs fmxp-agent-$SLUG --tail 1"
REGISTRY="${FMX_REGISTRY:-0xa94f27F18267d09349809f3e2AeF8e7767033e8F}"
# setStatus(id, Active) signed in node from the agent's key file: `cast send --private-key` put the key in argv,
# and cast takes a raw key only as an argument or from a terminal prompt. 1 gwei tip: signers include nothing below it.
(cd "$ROOT/agents" && FMX_KEY_FILE="$ROOT/.credentials/agents/$SLUG.key" FMX_AGENT_ID="$ID" FMX_REGISTRY="$REGISTRY" \
  FMX_RPC_URL="${FMX_RPC_URL:-https://rpc.ferminux.net}" node --input-type=module -e '
import { readFileSync } from "node:fs";
import { Contract, JsonRpcProvider, Wallet } from "ethers";
const e = process.env;
const raw = readFileSync(e.FMX_KEY_FILE, "utf8").trim();
const wallet = new Wallet(raw.startsWith("0x") ? raw : `0x${raw}`, new JsonRpcProvider(e.FMX_RPC_URL));
const registry = new Contract(e.FMX_REGISTRY, ["function setStatus(uint256 id, uint8 status)"], wallet);
const tx = await registry.setStatus(BigInt(e.FMX_AGENT_ID), 1, { maxPriorityFeePerGas: 10n ** 9n, maxFeePerGas: 2n * 10n ** 9n });
await tx.wait();
')
echo "$SLUG (agent #$ID) is ACTIVE with a live key"
