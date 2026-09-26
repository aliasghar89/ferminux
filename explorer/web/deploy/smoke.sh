#!/bin/sh
# Smoke test for the explorer.ferminux.net switch (DEPLOY.md step 5). POSIX sh + curl, read-only.
#   sh deploy/smoke.sh https://explorer.ferminux.net
# Expect: app routes 200 text/html no-cache + CSP; unknown routes 404 text/html (/validators too, until the build
# has the ValidatorHub address; then 200); /api* JSON from the index;
# legacy shapes 307/308 with a relative Location; /assets/* immutable; the Etherscan-style /api and
# /api/eth-rpc answer JSON-RPC; 0 mentions of Blockscout in the page.
B=${1:-https://explorer.ferminux.net}
H=$(mktemp)
t(){ printf "%-60.60s " "$1"; curl -s -o /dev/null -D "$H" -w "%{http_code} %{content_type}" "$B$1"; printf "  loc=%s cache=%s csp=%s\n" "$(grep -i '^location:' "$H" | tr -d '\r' | cut -c11-)" "$(grep -i '^cache-control:' "$H" | tr -d '\r' | cut -c16-)" "$(grep -ic '^content-security-policy:' "$H")"; }
A=$(curl -s "$B/" | grep -o '/assets/index-[^"]*\.js' | head -1)
for p in / /blocks '/blocks?tab=reorgs' /block/361974 /block/0xb45df4007404742861c578519f6d8d892a1b9fceb83f5ed284dc383c32e156df /block/countdown/500000 /txs \
  /tx/0x40d199e9c8818ce4dbae1d73078823b4892e964714951d587b049a54ac421ea5 '/address/0xF61d31FeC999af448C06fFaBB5EC28FbEE482847?tab=coin_balance_history' \
  /tokens /token/0x8a9Ae4D652cEba09Db8Ebf48D28C943b41B377Ae /token/0x84FE97C49Ffe4227d9ea139B5998C097D9C06ddd/instance/41 /accounts /verified-contracts /stats \
  '/search-results?q=Scribe' /api-docs /this-page-does-not-exist /validators /index.html \
  /api/v2/stats '/api?module=block&action=eth_block_number' /api/v2/main-page/blocks \
  /blocks/396000 /tx/0x40d199e9c8818ce4dbae1d73078823b4892e964714951d587b049a54ac421ea5/logs /address/0xF61d31FeC999af448C06fFaBB5EC28FbEE482847/transactions \
  /tokens/0x8a9Ae4D652cEba09Db8Ebf48D28C943b41B377Ae /charts /robots.txt /sitemap.xml /favicon.svg /fonts/inter-latin-var.woff2 "$A" /assets/nope.js; do t "$p"; done
echo "etherscan-style: $(curl -s "$B/api?module=block&action=eth_block_number")"
echo "eth-rpc proxy:   $(curl -s -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "$B/api/eth-rpc")"
echo "no Blockscout:   $(curl -s "$B/" | grep -ci blockscout) mentions in /"
rm -f "$H"
