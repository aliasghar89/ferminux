#!/usr/bin/env bash
# Give a model-backed agent its API key and set it Active on-chain.
#   agents/scripts/activate-agent.sh <slug> <LLM_API_KEY|cli> [model]
# "cli" = subscription mode: leave the key empty and rely on LLM_CLI (log in first with cli-login.sh on the box)
# slug ∈ claude gpt gemini llama mistral grok qwen deepseek scribe
set -euo pipefail
SLUG=$1; KEY=$2; MODEL=${3:-}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
ENV="$ROOT/.credentials/agents/secrets-netcup/agent-$SLUG.env"
[ -f "$ENV" ] || { echo "no $ENV"; exit 1; }
python3 - "$ENV" "$KEY" "$MODEL" <<'PY'
import sys,re
p,key,model=sys.argv[1:4]; s=open(p).read()
s=re.sub(r'^LLM_API_KEY=.*$', 'LLM_API_KEY=' + ('' if key=='cli' else key), s, flags=re.M)
if model: s=re.sub(r'^LLM_MODEL=.*$', f'LLM_MODEL={model}', s, flags=re.M)
open(p,'w').write(s)
PY
ID=$(cat "$ROOT/.credentials/agents/$SLUG.id"); PK=$(cat "$ROOT/.credentials/agents/$SLUG.key")
# Deployment target. Set FMX_DEPLOY_HOST (user@host) and FMX_DEPLOY_KEY for
# your own infrastructure; FMX_DEPLOY_DIR is where the compose stack lives.
H="${FMX_DEPLOY_HOST:?set FMX_DEPLOY_HOST=user@host}"
SSH="ssh -i ${FMX_DEPLOY_KEY:-$HOME/.ssh/id_ed25519}"
DIR="${FMX_DEPLOY_DIR:-/opt/ferminux/infra/compose}"
RSYNC_RSH="$SSH" rsync -az "$ENV" $H:$DIR/secrets/agent-$SLUG.env
$SSH $H "cd $DIR && chmod 600 secrets/agent-$SLUG.env && docker compose -f docker-compose.prod.yml -f docker-compose.servernet.yml -f docker-compose.mesh.yml -f docker-compose.agents.yml up -d --force-recreate agent-$SLUG >/dev/null 2>&1 && docker logs fmxp-agent-$SLUG --tail 1"
REGISTRY="${FMX_REGISTRY:-0xa94f27F18267d09349809f3e2AeF8e7767033e8F}"
cast send "$REGISTRY" "setStatus(uint256,uint8)" "$ID" 1 --private-key "$PK" --rpc-url "${FMX_RPC_URL:-https://rpc.ferminux.net}" --gas-price 2gwei --priority-gas-price 1gwei >/dev/null
echo "$SLUG (agent #$ID) is ACTIVE with a live key"
