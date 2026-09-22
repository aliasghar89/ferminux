#!/usr/bin/env node
// plan-pool.mjs — pool-planning calculator. Pure math, no network, no keys.
//
// Models a fresh Uniswap-v2 constant-product pool seeded with `capital` of
// quote (USD-denominated) against wFMX at `price`, then answers:
//   - pool depth
//   - slippage on $100 / $1k / $10k buys AND sells
//   - spot price after a given amount of sell pressure
//   - how many days of miner emission the pool absorbs before the price halves
//   - impermanent-loss exposure for the LP
//
//   node scripts/plan-pool.mjs --capital 50000 --price 0.52 --emission 12000
//   node scripts/plan-pool.mjs --compare 5000,25000,50000,100000 --price 0.52 --emission 12000 --markdown
//
// Fee note: Pancake v2 charges 0.25% (--fee-bps 25), Uniswap v2 and
// QuickSwap v2 charge 0.30% (--fee-bps 30, the default here).
//
// Planning precision: floating point. On-chain integer math differs in the
// last decimals, never in the shape of these numbers.

import { parseArgs, usage, fail } from "../lib/common.mjs";

const SPEC = {
  capital: { hint: "usd", desc: "quote capital seeding the pool (the FMX side is added on top, valued equally at open)" },
  compare: { hint: "usd,usd,...", desc: "run several capital levels and print one comparison table" },
  price: { required: true, hint: "usd", desc: "opening price, quote per FMX (e.g. 0.52)" },
  emission: { required: true, hint: "fmx/day", desc: "expected daily FMX emission hitting the market (see README for the chain's real schedule)" },
  "fee-bps": { default: "30", hint: "bps", desc: "pair swap fee: 25 Pancake v2, 30 Uniswap v2/QuickSwap v2" },
  "trade-sizes": { default: "100,1000,10000", hint: "usd,...", desc: "buy/sell sizes for the slippage tables" },
  "sell-pressure": { default: "1000,5000,10000,25000", hint: "usd,...", desc: "one-shot sell sizes for the price-after table" },
  markdown: { bool: true, desc: "emit GitHub-flavoured markdown tables" },
};

const o = parseArgs(process.argv, SPEC);
if (!o.capital && !o.compare) fail("give --capital or --compare\n\n" + usage(SPEC));
const P = Number(o.price);
const E = Number(o.emission);
const fee = Number(o["fee-bps"]) / 10000;
if (!(P > 0) || !(E >= 0) || !(fee >= 0 && fee < 0.05)) fail("bad --price/--emission/--fee-bps");
const tradeSizes = o["trade-sizes"].split(",").map(Number);
const pressures = o["sell-pressure"].split(",").map(Number);

// ---------------------------------------------------------------------------
// constant-product core (quote reserve Q, token reserve F)
// ---------------------------------------------------------------------------
const freshPool = (capital) => ({ Q: capital, F: capital / P });
const spot = (p) => p.Q / p.F;
function buyWithQuote(p, d) {
  const out = (d * (1 - fee) * p.F) / (p.Q + d * (1 - fee));
  p.Q += d; p.F -= out;
  return out; // FMX received
}
function sellTokens(p, dx) {
  const out = (dx * (1 - fee) * p.Q) / (p.F + dx * (1 - fee));
  p.F += dx; p.Q -= out;
  return out; // quote received
}

function analyze(capital) {
  const base = freshPool(capital);
  const r = {
    capital,
    depthQuote: base.Q,
    depthFmx: base.F,
    tvl: 2 * capital, // FMX side valued at the opening price
    buys: [], sells: [], pressure: [],
  };
  for (const d of tradeSizes) {
    const p = freshPool(capital);
    const got = buyWithQuote(p, d);
    const exec = d / got;
    r.buys.push({ usd: d, fmx: got, exec, slip: exec / P - 1, spotAfter: spot(p) });
  }
  for (const d of tradeSizes) {
    const p = freshPool(capital);
    const dx = d / P; // "$d worth" of FMX at the opening price
    const got = sellTokens(p, dx);
    const exec = got / dx;
    r.sells.push({ usd: d, fmx: dx, quoteOut: got, exec, slip: 1 - exec / P, spotAfter: spot(p) });
  }
  for (const X of pressures) {
    const p = freshPool(capital);
    const got = sellTokens(p, X / P);
    r.pressure.push({ usd: X, spotAfter: spot(p), drop: 1 - spot(p) / P, extracted: got });
  }
  // emission absorption: E FMX sold per day (in 0.1-day slices), until spot <= P/2
  {
    const p = freshPool(capital);
    const slice = E / 10;
    let t = 0, extracted = 0, sold = 0;
    const cap = 3650 * 10;
    if (E > 0) {
      for (let i = 0; i < cap && spot(p) > P / 2; i++) {
        extracted += sellTokens(p, slice);
        sold += slice; t += 0.1;
      }
    }
    r.halving = {
      days: E > 0 ? (t >= 3650 ? Infinity : t) : Infinity,
      fmxAbsorbed: sold,
      quoteExtracted: extracted,
      spotAfter: spot(p),
    };
  }
  // impermanent loss (fee income ignored — conservative)
  r.il = [0.25, 0.5, 0.75, 1.5, 2].map((ratio) => {
    const vHold = capital * (1 + ratio);
    const vLp = 2 * capital * Math.sqrt(ratio);
    return { ratio, il: vLp / vHold - 1, vLp, vHold };
  });
  return r;
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------
const usd = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = (n) => "$" + Math.round(n).toLocaleString("en-US");
const num = (n, dp = 2) => n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const pct = (n, dp = 2) => (n * 100).toFixed(dp) + "%";
const prc = (n) => "$" + n.toPrecision(4);

function printFull(r) {
  const md = o.markdown;
  const line = (s = "") => console.log(s);
  line();
  line(`# Pool plan — ${usd0(r.capital)} quote capital @ ${usd(P)}/FMX, fee ${(fee * 100).toFixed(2)}%, emission ${num(E, 0)} FMX/day`);
  line();
  line(`Pool depth: ${usd0(r.depthQuote)} quote + ${num(r.depthFmx, 0)} FMX  (TVL ${usd0(r.tvl)} at open)`);
  line();
  line(md ? `| Trade | Direction | Executed at | Slippage | Spot after |\n|---|---|---|---|---|` : "  Trade      Dir    Executed-at   Slippage   Spot-after");
  for (const b of r.buys) {
    const row = [usd0(b.usd), "BUY", prc(b.exec), pct(b.slip), prc(b.spotAfter)];
    line(md ? `| ${row.join(" | ")} |` : "  " + row.map((c) => c.padEnd(11)).join(" "));
  }
  for (const s of r.sells) {
    const row = [usd0(s.usd), "SELL", prc(s.exec), pct(s.slip), prc(s.spotAfter)];
    line(md ? `| ${row.join(" | ")} |` : "  " + row.map((c) => c.padEnd(11)).join(" "));
  }
  line();
  line("Sell-pressure (one-shot sale of FMX valued at the opening price):");
  line(md ? `| Sold | Seller receives | Spot after | Drop |\n|---|---|---|---|` : "  Sold       Receives     Spot-after   Drop");
  for (const p of r.pressure) {
    const row = [usd0(p.usd), usd0(p.extracted), prc(p.spotAfter), pct(p.drop)];
    line(md ? `| ${row.join(" | ")} |` : "  " + row.map((c) => c.padEnd(12)).join(" "));
  }
  line();
  const h = r.halving;
  if (h.days === Infinity) line(`Emission absorption: price does NOT halve within 10 years at ${num(E, 0)} FMX/day.`);
  else
    line(
      `Emission absorption: at ${num(E, 0)} FMX/day sold into the pool, the price HALVES after ~${h.days.toFixed(1)} days ` +
        `(${num(h.fmxAbsorbed, 0)} FMX absorbed; sellers walk away with ${usd0(h.quoteExtracted)} of the quote capital).`,
    );
  line();
  line("Impermanent loss (LP value vs just holding, fees ignored):");
  line(md ? `| FMX price | IL | LP position worth | Holding would be |\n|---|---|---|---|` : "  FMX-price   IL        LP-worth     Hold-worth");
  for (const e of r.il) {
    const row = [`${prc(P * e.ratio)} (x${e.ratio})`, pct(e.il), usd0(e.vLp), usd0(e.vHold)];
    line(md ? `| ${row.join(" | ")} |` : "  " + row.map((c) => c.padEnd(12)).join(" "));
  }
  line();
}

function printCompare(capitals) {
  const rs = capitals.map(analyze);
  const md = o.markdown;
  const cols = rs.map((r) => usd0(r.capital));
  const find = (r, arr, usdSize) => arr.find((x) => x.usd === usdSize);
  const rows = [
    ["Pool depth (quote + FMX)", rs.map((r) => `${usd0(r.depthQuote)} + ${num(r.depthFmx, 0)} FMX`)],
    ...tradeSizes.map((s) => [`Buy ${usd0(s)} — slippage`, rs.map((r) => pct(find(r, r.buys, s).slip))]),
    ...tradeSizes.map((s) => [`Sell ${usd0(s)} — slippage`, rs.map((r) => pct(find(r, r.sells, s).slip))]),
    ...pressures.map((s) => [`Spot after ${usd0(s)} sold`, rs.map((r) => { const p = find(r, r.pressure, s); return `${prc(p.spotAfter)} (${pct(-p.drop, 1)})`; })]),
    ["Days of emission to halve price", rs.map((r) => (r.halving.days === Infinity ? ">3650" : r.halving.days.toFixed(1)))],
    ["Quote extracted by then", rs.map((r) => (r.halving.days === Infinity ? "—" : usd0(r.halving.quoteExtracted)))],
    ["IL if FMX -50%", rs.map((r) => pct(r.il.find((e) => e.ratio === 0.5).il))],
    ["IL if FMX +100%", rs.map((r) => pct(r.il.find((e) => e.ratio === 2).il))],
  ];
  console.log();
  console.log(`Assumptions: open ${usd(P)}/FMX, swap fee ${(fee * 100).toFixed(2)}%, emission ${num(E, 0)} FMX/day sold into the pool, quote is USD-stable.`);
  console.log();
  if (md) {
    console.log(`| Metric | ${cols.join(" | ")} |`);
    console.log(`|---|${cols.map(() => "---").join("|")}|`);
    for (const [name, vals] of rows) console.log(`| ${name} | ${vals.join(" | ")} |`);
  } else {
    const w0 = Math.max(...rows.map(([n]) => n.length)) + 2;
    const w = 22;
    console.log(" ".repeat(w0) + cols.map((c) => c.padStart(w)).join(""));
    for (const [name, vals] of rows) console.log(name.padEnd(w0) + vals.map((v) => v.padStart(w)).join(""));
  }
  console.log();
}

if (o.compare) printCompare(o.compare.split(",").map(Number));
else printFull(analyze(Number(o.capital)));
