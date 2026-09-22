/* Tests the ACTUAL site JS (site/assets/app.js) logic against a live chain.
   Exercises: ?rpc= override resolution, batch request building, response
   parsing, DEX price math, tape vitals, and formatting — the exact code
   paths the live telemetry band runs. Prefers the local devnet on :8545,
   falls back to the production RPC when no devnet is running. */
const FMX = require(require('path').join(__dirname, '..', 'assets', 'app.js'));

async function main() {
  let failures = 0;
  const check = (name, cond, extra) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`);
    if (!cond) failures++;
  };

  // 1. ?rpc= override resolution (the exact mechanism the task requires)
  const r1 = FMX.resolveRpc('?rpc=http://localhost:8545', 'https://rpc.ferminux.net');
  check('?rpc= override wins', r1 === 'http://localhost:8545', r1);
  const r2 = FMX.resolveRpc('', 'https://rpc.ferminux.net');
  check('no override -> data-rpc attr', r2 === 'https://rpc.ferminux.net', r2);
  const r3 = FMX.resolveRpc('?rpc=javascript:alert(1)', 'https://rpc.ferminux.net');
  check('non-http override rejected', r3 === 'https://rpc.ferminux.net', r3);
  const r4 = FMX.resolveRpc('', null);
  check('no attr -> production default', r4 === 'https://rpc.ferminux.net', r4);

  // 2. Formatting units
  check('formatBaseFee 7 wei', FMX.formatBaseFee(7) === '7 wei', FMX.formatBaseFee(7));
  check('formatBaseFee 1 gwei', FMX.formatBaseFee(1e9) === '1 gwei', FMX.formatBaseFee(1e9));
  check('formatBaseFee 1.5 gwei', FMX.formatBaseFee(1.5e9) === '1.5 gwei', FMX.formatBaseFee(1.5e9));
  check('formatHeight groups', FMX.formatHeight(1234567) === '1,234,567', FMX.formatHeight(1234567));
  check('formatHeight null', FMX.formatHeight(null) === '—');
  check('formatGasLimit 100M', FMX.formatGasLimit(100000000) === '100M', FMX.formatGasLimit(100000000));
  check('formatGasLimit odd value falls back to grouping',
    FMX.formatGasLimit(30123456) === '30,123,456', FMX.formatGasLimit(30123456));
  check('formatInterval 6.94 -> 6.9 s', FMX.formatInterval(6.94) === '6.9 s', FMX.formatInterval(6.94));
  check('formatInterval 12.3 -> 12 s', FMX.formatInterval(12.3) === '12 s', FMX.formatInterval(12.3));
  check('formatHashrate 244 MH/s', FMX.formatHashrate(2.44e8) === '244 MH/s', FMX.formatHashrate(2.44e8));
  check('formatHashrate null', FMX.formatHashrate(null) === '—');

  // 3. DEX price math (getReserves ABI words: reserve0 FMX/1e18, reserve1 AZNT/1e6)
  const word = (v) => BigInt(v).toString(16).padStart(64, '0');
  const reservesHex = '0x' + word(2n * 10n ** 18n) + word(1n * 10n ** 6n) + word(0);
  const p = FMX.priceFromReserves(reservesHex);
  check('priceFromReserves 2 FMX / 1 AZNT -> 0.5', Math.abs(p - 0.5) < 1e-9, String(p));
  check('formatPrice sub-1 uses 4 dp', FMX.formatPrice(0.32444) === '0.3244', FMX.formatPrice(0.32444));
  check('priceFromReserves empty call -> null', FMX.priceFromReserves('0x') === null);
  check('priceFromReserves missing -> null', FMX.priceFromReserves(undefined) === null);
  check('priceFromReserves zero FMX reserve -> null',
    FMX.priceFromReserves('0x' + word(0) + word(1000000) + word(0)) === null);

  // 4. Stats batch shape + parse (ids 1-3 unchanged, id 4 = pair getReserves)
  const req = FMX.buildStatsRequest();
  check('stats batch has 4 requests', req.length === 4, String(req.length));
  check('stats batch id 4 targets the pair', req[3].method === 'eth_call' &&
    req[3].params[0].to === FMX.PAIR_ADDRESS, JSON.stringify(req[3].params[0]));
  const parsed = FMX.parseStatsResponse([
    { id: 1, result: '0x64' },
    { id: 2, result: { baseFeePerGas: '0x7', gasLimit: '0x5f5e100', timestamp: '0x1', difficulty: '0x2', number: '0x64' } },
    { id: 3, result: '0xf79' },
    { id: 4, result: reservesHex }
  ]);
  check('parse height', parsed.height === 100, String(parsed.height));
  check('parse baseFee', parsed.baseFeeWei === 7, String(parsed.baseFeeWei));
  check('parse chainId', parsed.chainId === 3961, String(parsed.chainId));
  check('parse gasLimit', parsed.gasLimit === 100000000, String(parsed.gasLimit));
  check('parse price', Math.abs(parsed.priceAznt - 0.5) < 1e-9, String(parsed.priceAznt));

  // 5. Block tape: request building, parsing, vitals
  const breq = FMX.buildBlocksRequest(5, 7);
  check('blocks batch 5..7 has 3 requests', breq.length === 3 && breq[0].id === 5 && breq[2].id === 7);
  check('blocks batch uses hex numbers', breq[0].params[0] === '0x5', breq[0].params[0]);
  const blocks = FMX.parseBlocksResponse([
    { id: 7, result: { number: '0x7', timestamp: '0xe', difficulty: '0x2bc', transactions: ['0xaa'] } },
    { id: 5, result: { number: '0x5', timestamp: '0x0', difficulty: '0x2bc', transactions: [] } },
    { id: 6, result: { number: '0x6', timestamp: '0x7', difficulty: '0x2bc', transactions: [] } }
  ]);
  check('parseBlocks sorts ascending', blocks.length === 3 && blocks[0].number === 5 && blocks[2].number === 7);
  check('parseBlocks counts txns', blocks[2].txns === 1, String(blocks[2].txns));
  const vitals = FMX.chainVitals(blocks);
  check('chainVitals avg interval 7 s', vitals.avgInterval === 7, String(vitals.avgInterval));
  check('chainVitals hashrate = difficulty / interval', vitals.hashrate === 100, String(vitals.hashrate));
  check('chainVitals needs 3+ blocks', FMX.chainVitals(blocks.slice(0, 2)).avgInterval === null);

  // 6. Offline fallback: unreachable RPC must reject (renderOffline path)
  let offlineOk = false;
  try { await FMX.fetchStats('http://localhost:59999'); }
  catch (e) { offlineOk = true; }
  check('unreachable RPC rejects (offline fallback path)', offlineOk);

  // 7. LIVE chain through the identical fetchStats/fetchBlocks code paths.
  //    Devnet on :8545 when running, else the production RPC.
  let rpc = FMX.resolveRpc('?rpc=http://localhost:8545', 'https://rpc.ferminux.net');
  try { await FMX.fetchStats(rpc); }
  catch (e) {
    console.log('(no devnet on :8545 — running the live section against ' + FMX.DEFAULT_RPC + ')');
    rpc = FMX.DEFAULT_RPC;
  }
  const stats = await FMX.fetchStats(rpc);
  check('live height is a number', Number.isInteger(stats.height) && stats.height > 0, String(stats.height));
  check('live chainId is 3961', stats.chainId === FMX.EXPECTED_CHAIN_ID, String(stats.chainId));
  check('live baseFee parsed', Number.isFinite(stats.baseFeeWei), String(stats.baseFeeWei));
  check('live gasLimit parsed', Number.isFinite(stats.gasLimit), String(stats.gasLimit));
  const live = await FMX.fetchBlocks(rpc, Math.max(0, stats.height - 9), stats.height);
  check('live tape headers fetched', live.length >= 2, String(live.length));
  const lv = FMX.chainVitals(live);

  console.log('---');
  console.log('LIVE  height=' + stats.height +
    '  rendered="' + FMX.formatHeight(stats.height) + '"' +
    '  baseFee="' + FMX.formatBaseFee(stats.baseFeeWei) + '"' +
    '  gasLimit="' + FMX.formatGasLimit(stats.gasLimit) + '"' +
    '  price="' + FMX.formatPrice(stats.priceAznt) + ' AZNT"' +
    '  avgBlock="' + FMX.formatInterval(lv.avgInterval) + '"' +
    '  hashrate="' + FMX.formatHashrate(lv.hashrate) + '"' +
    '  chainId=' + stats.chainId);
  console.log(failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
