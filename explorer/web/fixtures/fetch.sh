#!/bin/sh
# Re-fetch every fixture from the live Blockscout v2 API, the public RPC and the
# agent gateway. Each file is the raw response body (pretty-printed), so a page
# can be rendered against it offline. index.json maps file -> source URL + status.
#
#   sh fixtures/fetch.sh            # from explorer/web
#
# Samples were chosen on 2026-09-24 (head ~396.5k). See ../API.md for why each.
set -eu
cd "$(dirname "$0")"

B=https://explorer.ferminux.net/api/v2
R=https://rpc.ferminux.net
G=https://ferminux.net/api

# ---- sample entities -------------------------------------------------------
TX_FMX=0xf7c65387ece2210384b10c83408b7212b982138e49c7fe8218fe310d84ac80f0     # faucet 0.5 FMX drip, post-fork block 389882
TX_CALL=0x5c47134efc88e69e2b11c74409ad1c61c683a608e858e3abf4ddeedb24f73bc3    # AgentRegistry.register (PrismaQuill-FMX), 3 logs
TX_ESCROW=0xd71f38995c4789e1334da92a9b3a20a37c83ed8cbd322acfc608098ead9d76e3  # ServiceEscrow call, 1 log
TX_TOKENS=0x4b901e895aa9073bd6d1a1e5fdc643f41485786d6790e6e15b4183a40e2f200f  # DEX swap: WFMX + AZNT transfers + WFMX burn (pre-fork block 82711)
TX_NFT=0x281732b032658431f88e205db8db619be54087951fc7bafab512724044c08cca     # FMXA #10 mint
TX_INTERNAL=0x9f820129d73f54b8bc187eabb4006f0b8e3fcaaca38eff428c4f9f5ac0502581 # StreamPay.withdraw(): moves FMX internally, but internal txs are NOT indexed
ADDR_EOA=0xF61d31FeC999af448C06fFaBB5EC28FbEE482847      # plain EOA: hires agents, holds SCRB
ADDR_SIGNER=0x8e97f419F388c20E745dFF826587f359C31EF693   # one of the 5 authorised signers
ADDR_OWNER=0x6beE9D8F7f4B701d54dE273138F6994183707DD9    # agent owner (Scribe, agent #2)
ADDR_CONTRACT=0xa94f27F18267d09349809f3e2AeF8e7767033e8F # AgentRegistry (NOT verified: 0 verified contracts on chain)
FRC20=0x8a9Ae4D652cEba09Db8Ebf48D28C943b41B377Ae         # WFMX
FRC721=0x84FE97C49Ffe4227d9ea139B5998C097D9C06ddd        # FMXA (Ferminux Agents)
NFT_ID=41
BLOCK=396000        # post-fork authority block, signer already attributed by the seeder
BLOCK_POW=82711     # pre-fork proof-of-work block with a transaction

INDEX=index.json
printf '{\n  "fetchedAt": "%s",\n  "files": {\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$INDEX"
first=1

save() { # save <file> <url>
  f=$1; url=$2
  mkdir -p "$(dirname "$f")"
  code=$(curl -s -o "$f.tmp" -w '%{http_code}' --max-time 30 "$url") || code=000
  if python3 -m json.tool "$f.tmp" > "$f" 2>/dev/null; then rm -f "$f.tmp"; else mv "$f.tmp" "$f"; fi
  [ $first -eq 1 ] && first=0 || printf ',\n' >> "$INDEX"
  printf '    "%s": { "status": %s, "url": "%s" }' "$f" "$code" "$url" >> "$INDEX"
  echo "$code $f"
}
rpc() { # rpc <file> <method> <params-json>
  f=$1
  mkdir -p "$(dirname "$f")"
  curl -s --max-time 30 -X POST -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":$3}" "$R" | python3 -m json.tool > "$f"
  printf ',\n    "%s": { "status": 200, "url": "%s", "rpc": "%s", "params": %s }' "$f" "$R" "$2" "$3" >> "$INDEX"
  echo "rpc $f"
}

# ---- home / lists ----------------------------------------------------------
save home/stats.json                 "$B/stats"
save home/main-page-blocks.json      "$B/main-page/blocks"
save home/main-page-transactions.json "$B/main-page/transactions"
save home/indexing-status.json       "$B/main-page/indexing-status"
save home/charts-transactions.json   "$B/stats/charts/transactions"
save home/transactions-stats.json    "$B/transactions/stats"
save lists/blocks.json               "$B/blocks?type=block"
save lists/blocks-page2.json         "$B/blocks?type=block&block_number=$BLOCK&items_count=50"
save lists/transactions.json         "$B/transactions?filter=validated"
save lists/accounts.json             "$B/addresses"
save lists/tokens.json               "$B/tokens"
save lists/verified-contracts.json   "$B/smart-contracts"
save lists/smart-contracts-counters.json "$B/smart-contracts/counters"
save lists/verification-config.json "$B/smart-contracts/verification/config"
save lists/token-transfers.json      "$B/token-transfers"
save lists/internal-transactions.json "$B/internal-transactions"

# ---- transactions ----------------------------------------------------------
for pair in "fmx-transfer:$TX_FMX" "contract-call:$TX_CALL" "escrow-call:$TX_ESCROW" "token-transfers:$TX_TOKENS" "nft-mint:$TX_NFT" "internal:$TX_INTERNAL"; do
  n=${pair%%:*}; h=${pair#*:}
  save "tx/$n/tx.json"              "$B/transactions/$h"
  save "tx/$n/logs.json"            "$B/transactions/$h/logs"
  save "tx/$n/token-transfers.json" "$B/transactions/$h/token-transfers"
  save "tx/$n/internal-transactions.json" "$B/transactions/$h/internal-transactions"
  save "tx/$n/state-changes.json"   "$B/transactions/$h/state-changes"
done
save tx/contract-call/raw-trace.json "$B/transactions/$TX_CALL/raw-trace"
save tx/contract-call/summary.json   "$B/transactions/$TX_CALL/summary"
rpc  tx/contract-call/rpc-receipt.json eth_getTransactionReceipt "[\"$TX_CALL\"]"

# ---- addresses -------------------------------------------------------------
for pair in "eoa:$ADDR_EOA" "signer:$ADDR_SIGNER" "agent-owner:$ADDR_OWNER" "contract:$ADDR_CONTRACT"; do
  n=${pair%%:*}; a=${pair#*:}
  save "address/$n/address.json"          "$B/addresses/$a"
  save "address/$n/counters.json"         "$B/addresses/$a/counters"
  save "address/$n/tabs-counters.json"    "$B/addresses/$a/tabs-counters"
  save "address/$n/transactions.json"     "$B/addresses/$a/transactions"
  save "address/$n/token-transfers.json"  "$B/addresses/$a/token-transfers"
  save "address/$n/token-balances.json"   "$B/addresses/$a/token-balances"
  save "address/$n/tokens.json"           "$B/addresses/$a/tokens"
  save "address/$n/coin-balance-history-by-day.json" "$B/addresses/$a/coin-balance-history-by-day"
  save "address/$n/logs.json"             "$B/addresses/$a/logs"
  save "address/$n/nft.json"              "$B/addresses/$a/nft?type=ERC-721,ERC-404,ERC-1155"
done
save address/eoa/coin-balance-history.json       "$B/addresses/$ADDR_EOA/coin-balance-history"
save address/signer/blocks-validated.json        "$B/addresses/$ADDR_SIGNER/blocks-validated"
save address/agent-owner/internal-transactions.json "$B/addresses/$ADDR_OWNER/internal-transactions"
save address/contract/smart-contract.json        "$B/smart-contracts/$ADDR_CONTRACT"
save address/agent-owner/gateway-agents.json     "$G/agents?limit=50"
save address/agent-owner/gateway-agent-2.json    "$G/agents/2"
save address/agent-owner/gateway-accounts.json   "$G/accounts?owner=$ADDR_OWNER"
save address/agent-owner/gateway-network.json    "$G/network"
save address/agent-owner/gateway-tokens.json     "$G/tokens"

# ---- tokens ----------------------------------------------------------------
save token/frc20/token.json      "$B/tokens/$FRC20"
save token/frc20/counters.json   "$B/tokens/$FRC20/counters"
save token/frc20/transfers.json  "$B/tokens/$FRC20/transfers"
save token/frc20/holders.json    "$B/tokens/$FRC20/holders"
save token/frc721/token.json     "$B/tokens/$FRC721"
save token/frc721/counters.json  "$B/tokens/$FRC721/counters"
save token/frc721/transfers.json "$B/tokens/$FRC721/transfers"
save token/frc721/holders.json   "$B/tokens/$FRC721/holders"
save token/frc721/instances.json "$B/tokens/$FRC721/instances"
save token/frc721/instance-$NFT_ID.json           "$B/tokens/$FRC721/instances/$NFT_ID"
save token/frc721/instance-$NFT_ID-transfers.json "$B/tokens/$FRC721/instances/$NFT_ID/transfers"
save token/frc721/instance-$NFT_ID-holders.json   "$B/tokens/$FRC721/instances/$NFT_ID/holders"
save token/frc721/instance-$NFT_ID-transfers-count.json "$B/tokens/$FRC721/instances/$NFT_ID/transfers-count"

# ---- blocks ----------------------------------------------------------------
save block/authority/block.json         "$B/blocks/$BLOCK"
save block/authority/transactions.json  "$B/blocks/$BLOCK/transactions"
save block/pow/block.json               "$B/blocks/$BLOCK_POW"
save block/pow/transactions.json        "$B/blocks/$BLOCK_POW/transactions"
save block/by-hash.json                 "$B/blocks/0x80b22193df17a12c8fb2e81ccc1182fb50b9a698ec6462891d65350aff994151"
save block/countdown-future.json        "$B/blocks/999999/countdown"
rpc  block/authority/rpc-header.json    eth_getBlockByNumber "[\"0x60ae0\",false]"
rpc  block/authority/rpc-clique-getSigner.json clique_getSigner "[\"0x60ae0\"]"
rpc  block/rpc-clique-getSigners.json   clique_getSigners "[]"
rpc  block/rpc-clique-status.json       clique_status "[]"

# ---- search ----------------------------------------------------------------
save search/text-scribe.json       "$B/search?q=Scribe"
save search/text-fmx.json          "$B/search?q=FMX"
save search/quick-fmxa.json        "$B/search/quick?q=FMXA"
save search/block-number.json      "$B/search?q=$BLOCK"
save search/tx-hash.json           "$B/search?q=$TX_CALL"
save search/address.json           "$B/search?q=$ADDR_OWNER"
save search/no-match.json          "$B/search?q=zzzqqq-nothing"
save search/redirect-block.json    "$B/search/check-redirect?q=$BLOCK"
save search/redirect-tx.json       "$B/search/check-redirect?q=$TX_CALL"
save search/redirect-address.json  "$B/search/check-redirect?q=$ADDR_OWNER"

# ---- error shapes ----------------------------------------------------------
save errors/tx-not-found.json      "$B/transactions/0x0000000000000000000000000000000000000000000000000000000000000001"
save errors/tx-invalid-hash.json   "$B/transactions/0xnothex"
save errors/block-not-found.json   "$B/blocks/99999999"
save errors/block-invalid.json     "$B/blocks/abc"
save errors/address-invalid.json   "$B/addresses/0x123"
save errors/address-unused.json    "$B/addresses/0x000000000000000000000000000000000000dEaD"
save errors/token-not-found.json   "$B/tokens/0x000000000000000000000000000000000000dEaD"
save errors/unknown-route.json     "$B/nope"
save errors/disabled-summary.json  "$B/transactions/$TX_CALL/summary"
save errors/bad-page-params.json   "$B/blocks?type=block&block_number=abc&items_count=50"

printf '\n  }\n}\n' >> "$INDEX"
python3 -m json.tool "$INDEX" > /dev/null && echo "index ok"
