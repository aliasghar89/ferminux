# Explorer API map

This file maps the data behind every page of the new explorer at explorer.ferminux.net. The Blockscout 9.0.2 backend stays in place as a hidden indexer. Its UI is replaced.

All of it was measured live on 2026-09-24, with the head at about 396,500. The raw responses are saved under `fixtures/`, and `sh fixtures/fetch.sh` fetches them again. `fixtures/index.json` maps each file to its URL and HTTP status.

---

## 0. Findings that change the build

| # | Finding | What the explorer does |
|---|---|---|
| 1 | **Signer attribution is missing on the newest 50 blocks.** Page 1 of `/blocks`, `/main-page/blocks` and the websocket `new_block` push come from Blockscout's in-memory cache. There, every authority block shows `miner.hash = 0x000…0` and `rewards: []`. `/blocks/:n` and page 2 onward are fixed by the seeder within ~20 s. | For each block with `height >= 160000` and a zero `miner.hash`, send one **batched** `clique_getSigner` RPC call per page (a batch of 120 was tested and works), or recover the signer locally (§5). Compute the reward split from the schedule (§6.3). |
| 2 | **There are no internal transactions.** `INDEXER_DISABLE_INTERNAL_TRANSACTIONS_FETCHER=true`. The public RPC has no `debug_*` or `trace_*` methods, and it is not an archive node (`eth_getBalance` at an old block returns `missing trie node`). Every `/internal-transactions` endpoint returns `{"items":[]}`, and `internal_transactions_count` is `0` or `null`. | Hide the "Internal" tab. Show value moved by contracts through their decoded events instead (for example StreamPay `Withdrawn(payee, amount)`). Never render an empty table that implies "none happened". |
| 3 | **There are no verified contracts.** `/smart-contracts` is empty, and `/smart-contracts/counters` reports 19 contracts, 0 verified. So `decoded_input` and `log.decoded` are always `null`, and `method` is only the 4-byte selector. | Decode on the client with the repo's own ABIs (§6.1). This was tested: `register(...)`, `deliver(...)` and `withdraw()` plus their events all decode. Label the result "Decoded with the Ferminux ABI" (not "verified"). |
| 4 | **`state-changes` is wrong for contract payouts.** For `0x9f82…2581` (StreamPay.withdraw), the payee received 1.2947 FMX according to the `Withdrawn` log, but state-changes shows only `−fee` for it. The rows cover from, to, signer and token transfers only. | Use it only for a "Fee paid to signer" line and for token deltas. Do not present it as a full balance diff. |
| 5 | **`is_contract` fills in lazily.** On the first `/addresses/:a` hit, Blockscout reported escrow `0x99b3…a719` and vault `0x8751…aa57` as `is_contract:false` with no creator. The next call returned `true` and the creation tx. List items (`tx.to.is_contract`) can stay stale. | Treat `false` as "unknown" for addresses in the label book (§6.2). If a page needs certainty, call `eth_getCode`. |
| 6 | **Some stats are wrong or empty.** `gas_prices` reads 0.01 gwei, but the real price is ~1 gwei (`eth_gasPrice` = `0x3b9aca07`; signers enforce a 1 gwei tip). `total_gas_used:"0"`, `market_cap:"0"`, `coin_price:null`, `/addresses` `total_supply:"0"`. `total_blocks` is a cached count (395,739 against a head of 396,467). | Take the gas price from RPC. Show "—" for price, market cap and supply share. Show "Latest block" (the head height) rather than `total_blocks`. |
| 7 | **The stats microservice is absent** (`/stats-service/*` returns 404). The Tx Summary service is disabled (`/transactions/:h/summary` returns 403). `/raw-trace` returns 500. | Build `/stats` from the `/api/v2/stats/*` endpoints plus `clique_status`. Don't call summary or raw-trace. |
| 8 | **Search doesn't know agents.** `/search?q=Scribe` returns only the SCRB token. | Merge gateway agents (name → owner and agent id) into the search results on the client. |
| 9 | **Tab counters are capped at 51.** `tabs-counters.validations_count` returns `51`, while `counters.validations_count` returns `66345`. | Use `/counters` for real totals. Treat a `tabs-counters` value of 51 as "50+". |
| 10 | **Blockscout's own URL shapes** (`/tx/`, `/address/`, `/block/`, `/token/`) appear inside `search` result `url` fields. | The router uses exactly these shapes. |

---

## 1. Transport

| Source | Base | CORS | Limits | Notes |
|---|---|---|---|---|
| Blockscout REST v2 | `https://explorer.ferminux.net/api/v2` (same origin as the new site) | `access-control-allow-origin: *`, preflight 204 | **None measured.** Blockscout limits are off (`x-ratelimit-limit: -1`), the edge nginx has no `limit_req` for explorer, and a burst of 40 parallel requests all returned 200. No `cf-ray` header was seen, so no Cloudflare layer was detected. | `cache-control: max-age=0, private`. Typical latency is 250–450 ms, and lists with 50 txs take ~700 ms. |
| Etherscan-style API | `https://explorer.ferminux.net/api?module=…&action=…` | same | same | **Leave it alone.** It must keep proxying to backend:4000. Any unknown `/api/*` path also lands here: `400 {"message":"Params 'module' and 'action' are required parameters","result":null,"status":"0"}`. |
| Blockscout websocket | `wss://explorer.ferminux.net/socket/v2/websocket?vsn=2.0.0` | n/a | none | Works (§4). |
| Chain RPC | `https://rpc.ferminux.net` (POST JSON-RPC) | `*`, allows `Content-Type`, POST | **50 req/s per client IP, burst 100** (nginx `limit_req`). Excess requests get a 503. A JSON-RPC batch counts as one request. | Namespaces used: `eth_*`, `clique_getSigner(numberHex or hash)`, `clique_getSigners`, `clique_status`. Not available: `debug_*`, `trace_*`, historic state, and `wss://rpc.ferminux.net/ws` (closes with 1006). `clique_getSigner` rejects `"latest"`. |
| Agent gateway | `https://ferminux.net/api` | `*` | none seen | Fastify. It 404s as `{"message":"Route GET:/api/x not found","error":"Not Found","statusCode":404}`. |

### Pagination: `next_page_params`

Every paged list returns `{ "items": [...], "next_page_params": {…} | null }`. To get the next page, pass the object back verbatim as query params. Treat it as opaque, because the keys differ per endpoint. `items_count` accumulates (50, 100, 150…). **Unparseable params are silently ignored** and the server returns page 1. There is no total count and no jumping to page N. The UI should offer "Newer / Older" and keep a stack of previous `next_page_params` for going back.

| Endpoint | next_page_params keys (measured) |
|---|---|
| `/blocks`, `/addresses/:a/blocks-validated` | `block_number, items_count` |
| `/transactions`, `/addresses/:a/transactions`, `/addresses/:a/logs` | `block_number, index, items_count` |
| `/addresses` (accounts) | `hash, fetched_coin_balance, transactions_count, items_count` |
| `/tokens/:a/holders` | `address_hash, value, items_count` (Blockscout shape; not reached on this chain) |
| `/token-transfers`, `/tokens/:a/transfers` | `block_number, index` (not reached: WFMX has only 21 transfers) |

Pages hold 50 items, except `main-page/blocks` (4, not paged), `main-page/transactions` (6, not paged), `/search/quick` (a bare array) and `/addresses/:a/token-balances` (a bare array).

### Error shapes

| Case | Status | Body |
|---|---|---|
| Unknown tx, block or token | 404 | `{"message":"Not found"}` |
| Malformed tx hash | 422 | `{"message":"Invalid parameter(s)"}` |
| Malformed block id | 422 | `{"message":"Invalid number"}` |
| Malformed address | 422 | `{"errors":[{"title":"Invalid value","source":{"pointer":"/address_hash_param"},"detail":"Invalid format. Expected ~r/^0x([A-Fa-f0-9]{40})$/"}]}` |
| **Unused but valid address** | **200** | A full address object with `coin_balance:null` and every flag false. Render "No activity yet", not a 404. |
| Disabled service | 403 | `{"message":"Transaction Interpretation Service is disabled"}` |
| Raw trace | 500 | `"Error while raw trace fetching"` (a JSON string) |
| Unknown `/api/v2/*` route | 400 | the Etherscan-style body above |

The client should read `message`, or else `errors[0].detail`. It should map 404 and 422 to the explorer's own not-found state, keyed by the thing searched for.

### Value conventions

Wei amounts and big counts are **decimal strings**; parse them with `BigInt`. Timestamps are ISO-8601 UTC. Hashes come back checksummed. `average_block_time` is in ms. `gas_prices` is in gwei (and wrong, see #6). Token `decimals` is a string, and `null` for FRC-721. Token transfer `total` is `{decimals, value}` for FRC-20 and `{token_id, token_instance}` for FRC-721. Token transfers inside `/transactions/:h/token-transfers` have `timestamp: null`, so use the tx timestamp. Log `topics` are padded with `null` to length 4; drop those before decoding. `transaction_types` is empty (`[]`) for some contract calls that Blockscout never classified (because of #5).

---

## 2. Page → endpoint map

Every call below is `GET /api/v2…` unless marked **RPC** or **GW** (gateway). "Fixture" paths are relative to `fixtures/`.

### Home `/`

| Data | Call | Fixture |
|---|---|---|
| Counters (txs, addresses, avg block time, txs today) | `/stats` | `home/stats.json` |
| Latest 4 blocks (conveyor) | `/main-page/blocks`, plus **RPC** batch `clique_getSigner` for zero-signer rows | `home/main-page-blocks.json`, `block/authority/rpc-clique-getSigner.json` |
| Latest 6 txs | `/main-page/transactions` | `home/main-page-transactions.json` |
| 30-day tx sparkline | `/stats/charts/transactions` (`chart_data[{date, transactions_count}]`, 31 days, newest first) | `home/charts-transactions.json` |
| 24 h fees and count | `/transactions/stats` | `home/transactions-stats.json` |
| Signer panel | **RPC** `clique_getSigners`, `clique_status` (`sealerActivity`, `inturnPercent`, `numBlocks` = 64) | `block/rpc-clique-getSigners.json`, `block/rpc-clique-status.json` |
| Gas price | **RPC** `eth_gasPrice` / `eth_maxPriorityFeePerGas` | n/a |
| Agent counters (optional strip) | **GW** `/stats` | n/a |
| Indexer health | `/main-page/indexing-status` | `home/indexing-status.json` |

### Blocks `/blocks` (Blockscout also used `?tab=reorgs` and `?tab=uncles`)

`/blocks?type=block|reorg|uncle`. Reorgs exist (Clique out-of-turn races), and uncles exist from the proof-of-work era. Page 1 needs signer fill (#1). Fixtures: `lists/blocks.json`, `lists/blocks-page2.json`.

### Block `/block/:numberOrHash` (`?tab=txs`)

| Data | Call | Fixture |
|---|---|---|
| Header | `/blocks/:numberOrHash` (accepts a number or a hash) | `block/authority/block.json`, `block/pow/block.json`, `block/by-hash.json` |
| Txs | `/blocks/:n/transactions` | `block/*/transactions.json` |
| Signer and vanity (`extraData` is **not** in the v2 block) | **RPC** `eth_getBlockByNumber(hex,false)`, then §5, or `clique_getSigner` | `block/authority/rpc-header.json` |
| Future block | `/blocks/:n/countdown` returns `{countdown_block_number, current_block_number, remaining_blocks_count, estimated_time_in_seconds}`, an estimate to label as such | `block/countdown-future.json` |

For `height < 160000` (proof-of-work era), `miner.hash` is the real producer and `rewards` holds one "Miner Reward" row. Label it "Produced by" and "Block reward". From 160000 on, label it "Signer" and "Confirmed by".

### Transactions `/txs` (`?tab=pending`)

`/transactions?filter=validated` (paged), `/transactions?filter=pending` (always empty so far). Fixture: `lists/transactions.json`.

### Transaction `/tx/:hash` (`?tab=token_transfers|logs|state|internal|raw_trace`)

| Data | Call | Fixture |
|---|---|---|
| Overview | `/transactions/:h` | `tx/{fmx-transfer,contract-call,escrow-call,token-transfers,nft-mint,internal}/tx.json` |
| Token transfers | `/transactions/:h/token-transfers` (the tx object also embeds up to 50 of them, with `token_transfers_overflow`) | `tx/token-transfers/token-transfers.json` (a DEX swap: WFMX transfer, WFMX burn, AZNT transfer) |
| Logs (events) | `/transactions/:h/logs` | `tx/contract-call/logs.json` (3 AgentRegistry events) |
| Fee to signer and token deltas | `/transactions/:h/state-changes` (see #4) | `tx/*/state-changes.json` |
| Decoded input and events | client-side ABI (§6.1) on `raw_input`, `topics` and `data` | n/a |
| Signer of the tx's block | from the block, or RPC | n/a |
| ~~Internal~~ | returns `[]` (#2); tab hidden | `tx/internal/internal-transactions.json` |
| ~~Raw trace, summary~~ | 500 / 403 | `tx/contract-call/raw-trace.json`, `summary.json` |

The key tx fields are `hash, status ("ok"|"error"|null=pending), result, block_number, timestamp, confirmations, confirmation_duration [min_ms,max_ms], from, to, created_contract, value, fee{type,value}, gas_used, gas_limit, gas_price, base_fee_per_gas, max_fee_per_gas, max_priority_fee_per_gas, priority_fee, transaction_burnt_fee, nonce, position, type (2), method (selector), raw_input, decoded_input (null), revert_reason, transaction_types[], token_transfers[]`.

### Address `/address/:addr`

The Blockscout tab ids to honour are `txs`, `token_transfers`, `tokens`, `internal_txns`, `coin_balance_history`, `blocks_validated`, `logs`, `contract`, `read_contract`, `write_contract`. Map the last three to one "Contract" tab.

| Data | Call | Fixture |
|---|---|---|
| Header (balance, is_contract, creator, token) | `/addresses/:a` | `address/{eoa,signer,agent-owner,contract}/address.json` |
| Totals | `/addresses/:a/counters` (true totals) and `/tabs-counters` (which tabs to show, capped at 51) | `…/counters.json`, `…/tabs-counters.json` |
| `txs` | `/addresses/:a/transactions` (optional `?filter=to|from`) | `…/transactions.json` |
| `token_transfers` | `/addresses/:a/token-transfers` | `…/token-transfers.json` |
| `tokens` | `/addresses/:a/tokens?type=ERC-20` (paged) or `/token-balances` (a flat array, ok at this size) | `…/tokens.json`, `…/token-balances.json` |
| NFTs | `/addresses/:a/nft?type=ERC-721,ERC-404,ERC-1155` | `…/nft.json` |
| `coin_balance_history` | `/addresses/:a/coin-balance-history` (paged, `{block_number, block_timestamp, delta, transaction_hash, value}`) plus `/coin-balance-history-by-day` (`{items[{date,value}], days:10}`) | `address/eoa/coin-balance-history.json` |
| `blocks_validated` → label it "Blocks confirmed" | `/addresses/:a/blocks-validated` (DB-backed, so signers are correct) | `address/signer/blocks-validated.json` |
| `logs` (contracts) | `/addresses/:a/logs` | `address/contract/logs.json` |
| `contract` | `/smart-contracts/:a`. For unverified contracts it returns only `{creation_bytecode, deployed_bytecode, creation_status, proxy_type, implementations}`. Show the bytecode, and the ABI-decoded read view if the address is in the label book. | `address/contract/smart-contract.json` |
| Agent identity | **GW** `/agents?limit=50` (the `owner=` filter is **ignored**, so match on the client; there are only 13 agents), `/agents/:id`, `/accounts?owner=` (this one does filter), `/network` (nodes with `cv` URL), `/tokens` (agent tokens) | `address/agent-owner/gateway-*.json` |
| ~~`internal_txns`~~ | always empty (#2) | n/a |

### Tokens `/tokens`

`/tokens` (6 tokens; `type` is `ERC-20` or `ERC-721`, displayed as FRC-20 and FRC-721). Fixture: `lists/tokens.json`.

### Token `/token/:addr` (`?tab=token_transfers|holders|inventory|contract`)

| Data | Call | Fixture |
|---|---|---|
| Header | `/tokens/:a`, `/tokens/:a/counters` (`token_holders_count`, `transfers_count`) | `token/frc20/token.json`, `token/frc721/token.json` |
| Transfers | `/tokens/:a/transfers` | `token/*/transfers.json` |
| Holders | `/tokens/:a/holders` (`{address, value, token_id}`) | `token/*/holders.json` |
| Inventory (FRC-721) | `/tokens/:a/instances` (each item has metadata, `image_url` and `owner`) | `token/frc721/instances.json` |

### Token instance `/token/:addr/instance/:id` (`?tab=token_transfers|metadata`)

`/tokens/:a/instances/:id` (with `owner`, `metadata.attributes[]`, `image_url` → `https://ferminux.net/nft/agents/images/:id.png`), `/instances/:id/transfers`, `/instances/:id/transfers-count`. **`/instances/:id/holders` is empty for FRC-721**, so use `owner`. Fixtures: `token/frc721/instance-41*.json`.

### Accounts `/accounts`

`/addresses` returns items `{hash, coin_balance, transactions_count, is_contract, name}`, sorted by balance. `total_supply` is `"0"`, so the "% of supply" column is "—". Fixture: `lists/accounts.json`.

### Verified contracts `/verified-contracts`

`/smart-contracts` (empty) and `/smart-contracts/counters`. Render "0 verified of 19 contracts" honestly, and optionally list the label book's contracts, labelled "Published by Ferminux, source not verified here". Fixtures: `lists/verified-contracts.json`, `lists/smart-contracts-counters.json`.

### Stats `/stats`

`/stats`, `/stats/charts/transactions` (30 days), `/transactions/stats` (24 h), `/smart-contracts/counters`, `/tokens` count, and **RPC** `clique_status` / `clique_getSigners`. The block-time chart is not available from the API, so omit it or derive it from `/blocks` pages and label it "sample of the last N blocks".

### Search `/search-results?q=`

1. `/search/check-redirect?q=` returns `{redirect:true, type:"block"|"transaction"|"address", parameter}` on an exact hit. Navigate straight to `/block/<hash>`, `/tx/<hash>` or `/address/<a>`. (A number returns the block **hash** as `parameter`.)
2. Otherwise, `/search?q=` (paged). Item `type` is one of `token` (with `address_hash, name, symbol, token_type, total_supply`), `address`, `block`, `transaction`, … Each item has a Blockscout-shaped `url`.
3. For typeahead, use `/search/quick?q=`, which returns a bare array of the same items.
4. Merge in gateway agents by name (#8).

Fixtures: `search/*.json` (including `no-match.json` = `{"items":[],"next_page_params":null}`).

### 404

Unknown routes, and any API 404 or 422 from a detail call.

---

## 3. Shared object shapes (abridged)

- **AddressParam** (inside `from`, `to`, `miner`, `address`, `owner`): `{hash, name|null, is_contract, is_verified, implementations[], proxy_type, public_tags[], metadata|null, ens_domain_name|null}`.
- **Block**: `{height, hash, parent_hash, timestamp, miner:AddressParam, transactions_count, gas_used, gas_limit (100,000,000), gas_used_percentage, base_fee_per_gas ("7"), burnt_fees, priority_fee, transaction_fees, rewards[{type, reward}], difficulty (2 = in-turn, 1 = out-of-turn), size, nonce, total_difficulty, uncles_hashes[], type}`.
- **Log**: `{index, address:AddressParam, topics[4, null-padded], data, decoded:null, block_number, block_hash, transaction_hash, smart_contract:null}`.
- **TokenTransfer**: `{transaction_hash, log_index, block_number, block_hash, timestamp|null, type:"token_transfer"|"token_minting"|"token_burning", from, to, token:Token, total, method}`.
- **Token**: `{address_hash, name, symbol, type, decimals, total_supply, holders_count, icon_url:null, exchange_rate:null}`.
- **StateChange**: `{type:"coin"|"token", address, is_miner, balance_before, balance_after, change, token, token_id}`. Render `is_miner` as "signer".
- **Websocket `new_block`**: the same Block object (`fixtures/home/ws-new-block.json`), taken from the cache, so `miner` is zero.

---

## 4. Live updates: websocket or polling

`/socket/v2` **works**: it is Phoenix protocol v2, and the join replies `phx_reply ok`. Measured on topics:

- `blocks:new_block` pushes `{block}` about every 7 s (full object, zero signer).
- `transactions:new_transaction` returns join ok. No tx happened during the 24 s test, so no push was seen.
- `addresses:<hash>` topics were not tested.
- `stats:new_stats` returns "unmatched topic".

**Recommendation: poll.** The chain produces one block every 7 s and about 10 txs a day. Polling `/main-page/blocks` every 7 s and `/main-page/transactions` every 14 s, only while `!document.hidden`, costs about 0.2 req/s per open tab. There is no API rate limit, and it needs no heartbeat, reconnect, rejoin or backoff code. The pushed block would still need the RPC signer call. Diff by `height` and by tx `hash` to trigger the slide-in and digit-roll motion. Keep the Phoenix socket as a possible later upgrade for address pages (`addresses:<hash>`) if "live" balances are ever wanted.

---

## 5. Clique signer recovery

Signers can be read two ways:

- **What agents/web already does**, in `agents/web/src/pages/home.ts` (`rpc()` helper, lines 28–40, and `clique_getSigner` at line 123): it asks the node with `clique_getSigner(numberHex)`. Copy that helper. It is one call per block, or one batched call per page.
- **Local recovery**, when the RPC namespace is unavailable or the explorer wants to verify the node's answer. The algorithm is `chain/consensus/clique/clique.go` `SealHash`/`encodeSigHeader`:
  1. From `eth_getBlockByNumber(hex, false)`, take `extraData`. Its layout is `32-byte vanity ‖ [20×N signer list, epoch checkpoints only] ‖ 65-byte seal`. Measured: normal blocks are 97 B; checkpoints (every 30,000 blocks from 180,000) are 197 B, with 5 signers. The vanity is ASCII such as `fmx-signer5`. Break-glass blocks carry extra payload but still end in the 65-byte seal.
  2. RLP-encode this list: `[parentHash, sha3Uncles, miner (0x0), stateRoot, transactionsRoot, receiptsRoot, logsBloom, difficulty, number, gasLimit, gasUsed, timestamp, extraData[:-65], mixHash, nonce, baseFeePerGas]`. Integers are minimal big-endian, and zero is the empty string. `baseFeePerGas` is appended only when present, and it is present on every block here (EIP-1559 from genesis).
  3. `sealHash = keccak256(rlp)`. The seal is `r(32) ‖ s(32) ‖ v(1)` with v ∈ {0,1}.
  4. `signer = ecrecover(sealHash, seal)`.
  5. Blocks below **160,000** are proof-of-work: `extraData` is 30 B with no seal, and `miner` is the real producer.

The tested snippet (full file with the live test: `scripts/clique-signer.test.mjs`):

```js
import { encodeRlp, keccak256, recoverAddress, Signature, toBeArray, getAddress, dataSlice, dataLength } from "ethers"; // v6

export const POSA_BLOCK = 160000;
const q = (hex) => toBeArray(BigInt(hex)); // minimal big-endian; 0 -> empty

export function signerOf(h /* raw eth_getBlockBy* result */) {
  if (Number(BigInt(h.number)) < POSA_BLOCK) return null; // proof-of-work era: use h.miner
  const n = dataLength(h.extraData);
  const fields = [h.parentHash, h.sha3Uncles, h.miner, h.stateRoot, h.transactionsRoot, h.receiptsRoot, h.logsBloom,
    q(h.difficulty), q(h.number), q(h.gasLimit), q(h.gasUsed), q(h.timestamp),
    dataSlice(h.extraData, 0, n - 65), h.mixHash, h.nonce];
  if (h.baseFeePerGas != null) fields.push(q(h.baseFeePerGas));
  const seal = dataSlice(h.extraData, n - 65);
  const v = parseInt(dataSlice(seal, 64), 16);
  const sig = Signature.from({ r: dataSlice(seal, 0, 32), s: dataSlice(seal, 32, 64), v: v < 27 ? v + 27 : v });
  return getAddress(recoverAddress(keccak256(encodeRlp(fields)), sig));
}
```

**Test result (2026-09-24, ethers 6.17.0): 25/25 passed.** Each of 24 authority blocks matched the node's own `clique_getSigner`. They were the head and the 4 blocks below it, #160000 and #160001 (the first authority blocks), the checkpoints #180000, #210000 and #390000 (197 B extraData), #389886 (with a tx), #362339, and 12 random heights. Block #82711 (proof-of-work) correctly returned `null`, with the producer in `miner`.

The current authorised signers (`clique_getSigners`) are `0x1538…bb0f`, `0x3322…187d`, `0x7137…19b0`, `0x8e97…f693` and `0xa46a…de23`. In the last 64 blocks, `0x1538` and `0xa46a` confirmed 0 blocks, per `clique_status.sealerActivity`.

---

## 6. Client-side enrichment

### 6.1 ABI decoding

The ABIs are `agents/web/src/abi.generated.ts` (from `agents/contracts/abi/*.json`): AgentRegistry, ServiceEscrow, FerminuxAgents, X402Vault, AgentAccount(+Factory), StreamPay, ArbiterPool, Identity/Reputation/Validation8004, AgentTokenFactory, AgentToken. Use `new Interface(abi).parseTransaction({data: raw_input, value})` and `parseLog({topics: topics.filter(Boolean), data})`. For anything unknown, fall back to a generic FRC-20/721 plus WFMX/pair event set (`Transfer`, `Approval`, `Deposit`, `Withdrawal`, `Swap`, `Sync`, `Mint`, `Burn`). Base contracts, DEX and bridge ABIs are in `contracts/out`, `dex/contracts/out` and `bridge/contracts/out`.

### 6.2 Label book (address → name), all public on-chain addresses

| Name | Address |
|---|---|
| AgentRegistry | `0xa94f27F18267d09349809f3e2AeF8e7767033e8F` |
| ServiceEscrow | `0x99b331495951dB91857902de91EAe9Ff54d8a719` |
| Ferminux Agents (FMXA, FRC-721) | `0x84FE97C49Ffe4227d9ea139B5998C097D9C06ddd` |
| X402Vault | `0x8751Cf7e29Fe588c61FDc53323438247198eaa57` |
| AgentAccountFactory / impl | `0x82e7C593785f726A0A0BB4D37AbCaF2bA4a72dcb` / `0xb110021fAFcB541081aDA72da58964BA74c63942` |
| StreamPay | `0x59404F738A90E5CF725F5837EF40461d1EA2EC35` |
| ArbiterPool | `0x367312B28f78dE97462905519337841e4d4cB2df` |
| Identity / Reputation / Validation 8004 | `0xf3e8c83a…2147` / `0xd5984C5a…8884` / `0x37feB1B3…ab97` (full in `agents/deployments.3961.json`) |
| AgentTokenFactory | `0xf9fcCF337a7930D146227601C1da7Be85bB50188` |
| Multisig (governance) | `0x910BD467D8576277f8f96DF47428377FFD94fEfe` |
| AZNT (Ferminux Manat) | `0xFc81ad7c145B868ef0CEC8D7Ec881Ac93f724178` |
| TokenFactory (v1) | `0x62BC7d9671EfE1385413434aB8fdfE2fa4aE01D4` |
| Faucet | `0xf4dE70068031DA17347cd19aCaa841013751B3c0` |
| FMXVesting | `0x6F488FB1f382Bc96Fef8bBfCa28A9647E5Fe430B` |
| WFMX | `0x8a9Ae4D652cEba09Db8Ebf48D28C943b41B377Ae` |
| DEX Factory / Router / LiquidityLocker | `0x2034a8366fCdbfFCf4517D297f702aDDdba37040` / `0x018C0Efca293F7a74D2f53ce738BA5e2f412BA9f` / `0xe588c594388B978E64B69E2Dd91CC7E302763951` |
| Bridge (3961 side) | `0x498Bc2c68051ca86B4bE95Eb586f7f18b680CB4e` |
| Reward sink | `0x691E5275BF346FfFa0B30174dDBeDfCC078dd8D6` |
| Treasury | `0xc0A5Eb613f859f072554F29f1Ab7400265af15aB` |
| Signers 1–5 | from `clique_getSigners`, named by their vanity |
| Agent owners | from **GW** `/agents` (`owner` → `name #id`), refreshed every 60 s |

Sources: `agents/deployments.3961.json`, `.credentials/deployed-contracts.txt` (public addresses only) and `explorer/seeder/seed-rewards.sql`.

### 6.3 Block reward split (from 160,000)

Blockscout reward rows have no address. The two "Emission Reward" rows are the reward sink (50%) and the treasury (10%). "Miner Reward" is the signer's 40% plus tips. The subsidy is `1 FMX >> floor(n / 4,500,000)`, divided by 4, which is 0.25 FMX today: signer 0.1, sink 0.125, treasury 0.025. The signer also receives `priority_fee`. When `rewards` is `[]` (page-1 cache), compute the split from this schedule and label it "per schedule". It is deterministic, not an estimate, but it has not been read from the index.

---

## 7. Serving (the part that must not break)

The nginx inside the explorer stack (`explorer/proxy/default.conf`) currently sends `^/(api|socket|sitemap.xml|…)` to backend:4000 and everything else to the Next.js frontend:3000. The swap only changes the second branch: serve `explorer/web/dist` statically, falling back to `/index.html`, with long cache on hashed assets. `/api`, `/api/v2/*` and `/socket/*` stay on the backend untouched, so the Etherscan-compatible `/api` keeps working. The Blockscout frontend container can then be stopped.

---

## 8. Fixture index (sample entities)

| Entity | Id | Why |
|---|---|---|
| FMX transfer | `0xf7c65387…80f0` (block 389882) | a plain 0.5 FMX send; state-changes shows the signer fee |
| Contract call + logs | `0x5c47134e…3bc3` AgentRegistry `register()` | 3 events; decodes with the local ABI |
| Escrow call | `0xd71f3899…76e3` ServiceEscrow `deliver()` | Listed with `transaction_types: []` and `to.is_contract:false` until the escrow address was first opened; now `contract_call` (#5) |
| Token transfers | `0x4b901e89…200f` DEX swap (block 82711, proof-of-work era) | WFMX transfer and burn, AZNT transfer |
| NFT mint | `0x281732b0…8cca` FMXA #10 | FRC-721 `token_minting` with instance metadata |
| "Internal" | `0x9f820129…2581` StreamPay `withdraw()` | moves 1.2947 FMX internally; the API shows nothing (#2, #4) |
| EOA | `0xF61d31Fe…2847` | ~30 txs, 13–16 token transfers (counters and lists disagree slightly), SCRB + WFMX balances |
| Signer | `0x8e97f419…f693` | blocks-validated (66,345), no txs |
| Agent owner | `0x6beE9D8F…7DD9` (Scribe, agent #2) | StreamPay/x402/token-factory activity, AgentAccount `0x4C53…FC13` |
| Contract | `0xa94f27F1…3e8F` AgentRegistry | unverified smart-contract shape, 50+ logs (paged) |
| FRC-20 | WFMX `0x8a9Ae4D6…77Ae` | 3 holders, 21 transfers |
| FRC-721 | FMXA `0x84FE97C4…6ddd`, instance #41 (J1) | 2 minted (#10, #41) |
| Blocks | 396000 (authority, seeded), 82711 (proof-of-work, with tx), by-hash | |
| Search | text / quick / number / tx / address / no-match / check-redirect ×3 | |
| Errors | 10 shapes | `errors/*.json` |
