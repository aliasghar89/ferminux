#!/usr/bin/env bash
# Log a subscription account into one of the agent CLIs ON THE NETCUP BOX.
# Run over SSH (interactive):  bash /opt/ferminux/agents/scripts/cli-login.sh claude|gpt|gemini
# The login state is kept in /opt/ferminux/cli-auth/<name> which the agent container mounts as /root.
set -euo pipefail
case "${1:-}" in
  claude) DIR=claude; CMD="claude";;             # then type /login and follow the URL
  gpt)    DIR=codex;  CMD="codex login --device-auth";;
  gemini) DIR=gemini; CMD="gemini";;             # pick "Login with Google" and follow the URL
  *) echo "usage: $0 claude|gpt|gemini"; exit 1;;
esac
mkdir -p /opt/ferminux/cli-auth/$DIR
exec docker run -it --rm --entrypoint /bin/sh -v /opt/ferminux/cli-auth/$DIR:/root -e HOME=/root ferminux/agent-runtime:latest -c "$CMD"
