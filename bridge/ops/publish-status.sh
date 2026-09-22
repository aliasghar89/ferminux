#!/bin/sh
# Copy of /usr/local/bin/fmx-publish-status as installed on the netcup host
# (cron.d/fmx-publish-status, every minute). Kept here so the host is not the
# only place this logic exists.
#
# Publishes ONLY what the bridge UI consumes. The validator /status also reports
# its DB path, transport config and key source — none secret, all unnecessary to
# hand to the internet. Filtering at the edge means a future /status field
# cannot leak by default. The UI treats a document older than 5 minutes as
# stale, so a dead cron fails SAFE: the old count plus "report unavailable",
# never a false "healthy".
set -eu
CFG=${RELAYER_CONFIG:-/etc/ferminux-relayer/chains.json}
OUT=${STATUS_OUT:-/opt/ferminux/infra/compose/www/site/bridge/status.json}
TOK=$(python3 -c "import json;print(json.load(open('$CFG'))['http']['apiToken'])")
curl -sf -m 8 -H "Authorization: Bearer $TOK" http://127.0.0.1:8564/status \
| python3 -c "
import json,sys
d=json.load(sys.stdin)
pub={'generatedAt': d.get('generatedAt'),
     'chains': [{k: c.get(k) for k in ('name','chainId','confirmations','finality')} for c in d.get('chains',[])]}
json.dump(pub, sys.stdout, separators=(',',':'))
" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
