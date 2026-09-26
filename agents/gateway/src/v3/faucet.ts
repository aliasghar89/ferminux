// Gasless faucet: a brand-new key has 0 FMX and therefore cannot even call the
// on-chain faucet's drip() — an agent arriving alone (no human, no wallet UI)
// was stuck. POST /api/faucet {address} sends FAUCET_DRIP_FMX (default 0.5)
// from the relayer wallet. Limits: 1 drip / address / 24 h, 10 / IP / day,
// FAUCET_MAX_PER_DAY (default 100) globally, never below the relayer reserve, only to addresses that hold less
// than the drip amount, and only to keys that have never sent a transaction
// (nonce 0) — the faucet exists to give a brand-new key its first gas, so a
// key that already transacted is farming. FAUCET_POW_BITS > 0 additionally
// requires an anti-abuse puzzle answer: `pow` such that keccak256(utf8(lower(address) +
// ":" + pow)) has that many leading zero bits (~1 s of CPU at 20 bits).
import type { FastifyInstance } from "fastify";
import { getAddress, parseEther, formatEther, keccak256, toUtf8Bytes } from "ethers";
import { HttpError } from "../commons/context.js";
import { dayStart, type V3Context } from "./context.js";
import { RELAY_PRIORITY_FEE_WEI } from "./relay.js";

export const FAUCET_DRIP_WEI = parseEther(process.env.FAUCET_DRIP_FMX || "0.5");
const DRIP_WEI = FAUCET_DRIP_WEI;
export const FAUCET_PER_IP_PER_DAY = 10;
const PER_IP_PER_DAY = FAUCET_PER_IP_PER_DAY;
// 100/day (was 500): 500 × 0.5 FMX exceeded the relayer's whole balance, so ~40 IPs with fresh keys could
// empty it in one UTC day — and the relayer also pays for every gasless relay and account creation.
export const FAUCET_GLOBAL_PER_DAY = Number(process.env.FAUCET_MAX_PER_DAY || 100);
/** The faucet stops before the relayer drops below this, so gasless relays keep their gas (FAUCET_RELAYER_RESERVE_FMX, default 50). */
export const FAUCET_RELAYER_RESERVE_WEI = parseEther(process.env.FAUCET_RELAYER_RESERVE_FMX || "50");
const GLOBAL_PER_DAY = FAUCET_GLOBAL_PER_DAY;
export const FAUCET_POW_BITS = Math.max(0, Math.min(40, Number(process.env.FAUCET_POW_BITS || 0)));
const DAY_S = 86_400;

/** Number of leading zero bits of keccak256(lower(address) + ":" + pow). */
export function powBits(address: string, pow: string): number {
  const h = keccak256(toUtf8Bytes(`${address.toLowerCase()}:${pow}`)).slice(2);
  let bits = 0;
  for (const ch of h) {
    const n = parseInt(ch, 16);
    if (n === 0) {
      bits += 4;
      continue;
    }
    bits += Math.clz32(n) - 28;
    break;
  }
  return bits;
}

export function registerFaucetRoutes(app: FastifyInstance, ctx: V3Context): void {
  const { db, commons } = ctx;
  const lastForAddr = db.prepare("SELECT createdAt FROM relays WHERE kind = 'faucet' AND lower(subject) = lower(?) AND ok = 1 ORDER BY createdAt DESC LIMIT 1");
  const countIp = db.prepare("SELECT COUNT(*) AS c FROM relays WHERE kind = 'faucet' AND target = ? AND createdAt >= ? AND ok = 1");
  const countAll = db.prepare("SELECT COUNT(*) AS c FROM relays WHERE kind = 'faucet' AND createdAt >= ? AND ok = 1");
  const insert = db.prepare("INSERT INTO relays (kind, subject, target, txHash, ok, error, gasLimit, createdAt) VALUES ('faucet', ?, ?, ?, ?, ?, 21000, ?)");

  app.get("/api/faucet", async () => ({
    enabled: !!ctx.relayer,
    dripFmx: formatEther(DRIP_WEI),
    perAddress: "1 per 24 h",
    perIp: `${PER_IP_PER_DAY} per day`,
    globalPerDay: GLOBAL_PER_DAY,
    relayerReserveFmx: formatEther(FAUCET_RELAYER_RESERVE_WEI),
    usedToday: (countAll.get(dayStart(ctx.nowS())) as { c: number }).c,
    freshKeysOnly: true,
    pow: FAUCET_POW_BITS > 0 ? { bits: FAUCET_POW_BITS, how: `include "pow": a string such that keccak256(utf8(lowercase(address) + ":" + pow)) starts with ${FAUCET_POW_BITS} zero bits` } : null,
    how: "POST /api/faucet {\"address\":\"0x…\"} — no signature, no gas, no human needed; then register with AgentRegistry.register (minBond is 0).",
  }));

  app.post("/api/faucet", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (req, reply) => {
    try {
      if (!ctx.relayer) return reply.code(503).send({ disabled: true, reason: "faucet disabled (RELAYER_KEY unset)" });
      const body = commons.parseJson(req);
      let address: string;
      try {
        address = getAddress(String(body.address));
      } catch {
        throw new HttpError(400, "address must be a 0x address");
      }
      const now = ctx.nowS();
      const ip = String(req.ip || "?");
      const last = lastForAddr.get(address) as { createdAt: number } | undefined;
      if (last && now - last.createdAt < DAY_S) throw new HttpError(429, `already dripped to this address; retry in ${Math.ceil((DAY_S - (now - last.createdAt)) / 60)} min`, "faucet_cooldown");
      if ((countIp.get(ip, dayStart(now)) as { c: number }).c >= PER_IP_PER_DAY) throw new HttpError(429, "faucet limit for this IP reached today", "faucet_ip_limit");
      if ((countAll.get(dayStart(now)) as { c: number }).c >= GLOBAL_PER_DAY) throw new HttpError(503, "faucet is empty for today", "faucet_daily_cap");
      if (FAUCET_POW_BITS > 0) {
        const pow = typeof body.pow === "string" ? body.pow : "";
        if (!pow || pow.length > 64 || powBits(address, pow) < FAUCET_POW_BITS) throw new HttpError(400, `anti-abuse puzzle required: keccak256(utf8(lowercase(address) + ":" + pow)) must start with ${FAUCET_POW_BITS} zero bits (see GET /api/faucet)`, "faucet_pow");
      }
      const [bal, txCount, relayerBal] = await Promise.all([ctx.provider.getBalance(address), ctx.provider.getTransactionCount(address), ctx.provider.getBalance(ctx.relayer.address)]);
      if (relayerBal - DRIP_WEI < FAUCET_RELAYER_RESERVE_WEI) throw new HttpError(503, "faucet paused: the relayer is down to its reserve for gasless relays — try again after it is topped up", "faucet_reserve");
      if (bal >= DRIP_WEI) throw new HttpError(400, `address already holds ${formatEther(bal)} FMX — the faucet is for empty wallets`, "faucet_not_needed");
      if (txCount > 0) throw new HttpError(400, `address has already sent ${txCount} transaction(s) — the faucet only funds fresh keys`, "faucet_used_key");
      const fee = await ctx.provider.getFeeData();
      const tx = await ctx.relayer.sendTransaction({
        to: address,
        value: DRIP_WEI,
        maxPriorityFeePerGas: RELAY_PRIORITY_FEE_WEI,
        maxFeePerGas: (fee.maxFeePerGas ?? 0n) > 2n * RELAY_PRIORITY_FEE_WEI ? fee.maxFeePerGas! : 2n * RELAY_PRIORITY_FEE_WEI,
      });
      insert.run(address, ip, tx.hash, 1, null, now);
      return reply.code(202).send({ address, txHash: tx.hash, tx: tx.hash, amountFmx: formatEther(DRIP_WEI), next: "call AgentRegistry.register(name, endpoint, metadataURI, pricePerJob) with value 0 — see https://ferminux.net/llms-full.txt" });
    } catch (err) {
      return commons.sendError(reply, err);
    }
  });
}
