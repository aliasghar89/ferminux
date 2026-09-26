// The gas faucet's rules, in one place for /faucet/ and /playground/. Pure functions (no DOM, no network), so
// test/faucet.test.mjs runs them under plain Node. The gateway (agents/gateway/src/v3/faucet.ts) enforces the
// same rules; the page checks what it can first so a person reads a plain sentence instead of an error code.
import { getAddress, keccak256, toUtf8Bytes } from "ethers";

export type Check<T> = { ok: true; value: T } | { ok: false; error: string };

/** GET /api/faucet. Every field but `enabled` is optional: older gateways send less. */
export interface FaucetStatus {
  enabled: boolean;
  dripFmx?: string;
  perAddress?: string;
  perIp?: string;
  globalPerDay?: number;
  usedToday?: number;
  relayerReserveFmx?: string;
  freshKeysOnly?: boolean;
  pow?: { bits: number; how?: string } | null;
}

/** An address the faucet can pay: any case, a correct checksum when mixed case, never the zero address. */
export function checkFaucetAddress(raw: string): Check<string> {
  const s = raw.trim();
  if (!s) return { ok: false, error: "Enter the address that should receive the gas." };
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return { ok: false, error: "An address is 0x followed by 40 characters (0-9, a-f)." };
  const hex = s.slice(2);
  const mixed = /[a-f]/.test(hex) && /[A-F]/.test(hex);
  let out: string;
  try { out = getAddress(mixed ? s : s.toLowerCase()); } catch { return { ok: false, error: "The capital letters do not match this address's checksum. Check for a mistyped character, or paste it in lowercase." }; }
  if (/^0x0{40}$/i.test(out)) return { ok: false, error: "The zero address cannot receive gas." };
  return { ok: true, value: out };
}

/** "already dripped to this address; retry in 1375 min" → 1375. */
export function retryMinutes(message: string): number | null {
  const m = /retry in (\d+) min/i.exec(message);
  return m ? Number(m[1]) : null;
}

/** 1375 → "22 h 55 min"; 40 → "40 min". */
export function waitText(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), r = min % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/**
 * What to tell a person when POST /api/faucet refuses. `code` is the gateway's machine code; older gateways and
 * the per-connection rate limiter send none, so the status and message decide then.
 */
export function faucetRefusal(e: { status: number; code?: string; message: string }, s?: FaucetStatus | null): string {
  const drip = s?.dripFmx ?? "0.5";
  const global = s?.globalPerDay != null ? `all ${s.globalPerDay.toLocaleString("en-US")}` : "all";
  switch (e.code) {
    case "faucet_cooldown": {
      const min = retryMinutes(e.message);
      return `This address already received gas in the last 24 hours.${min != null ? ` It can ask again in ${waitText(min)}.` : ""}`;
    }
    case "faucet_ip_limit": return `This connection has used its ${s?.perIp ? s.perIp.replace(/ per day$/, "") : "10"} requests for today. The count resets at 00:00 UTC.`;
    case "faucet_daily_cap": return `Today's faucet budget is spent: ${global} drips for the day are gone. It resets at 00:00 UTC.`;
    case "faucet_reserve": return "The faucet is paused. Its wallet is down to the reserve it keeps for gas-free relays, and it resumes once that wallet is topped up.";
    case "faucet_not_needed": return `${sentence(e.message)} The faucet only funds empty keys (below ${drip} FMX).`;
    case "faucet_used_key": return `${sentence(e.message)} The faucet only funds keys that have never sent a transaction.`;
    case "faucet_pow": return "The anti-abuse puzzle answer was not accepted. Reload the page and try again.";
  }
  if (e.status === 429) return "Too many requests from this connection. Wait a minute, then try again.";
  if (e.status === 503) return /disabled|RELAYER_KEY/i.test(e.message) ? "The faucet is switched off on this gateway right now." : sentence(e.message);
  if (e.status === 400 && /0x address/i.test(e.message)) return "That is not a valid address.";
  return sentence(e.message || "The faucet did not answer. Try again in a minute.");
}

/** The gateway writes lower-case fragments ("address already holds 3.0 FMX — the faucet is …"): keep the fact, drop the aside. */
function sentence(msg: string): string {
  const head = msg.split(" — ")[0]!.trim();
  if (!head) return "";
  const s = head[0]!.toUpperCase() + head.slice(1);
  return /[.!?]$/.test(s) ? s : s + ".";
}

/** Leading zero bits of a 0x-prefixed keccak256 digest. Mirrors the gateway's powBits(). */
export function leadingZeroBits(hex: string): number {
  let bits = 0;
  for (const ch of hex.slice(2)) {
    const n = parseInt(ch, 16);
    if (n === 0) { bits += 4; continue; }
    bits += Math.clz32(n) - 28;
    break;
  }
  return bits;
}

/** The answer the gateway checks: keccak256(utf8(lowercase(address) + ":" + pow)) starts with `bits` zero bits. */
export const powOk = (address: string, pow: string, bits: number) => leadingZeroBits(keccak256(toUtf8Bytes(`${address.toLowerCase()}:${pow}`))) >= bits;

/** Hashes in slices, handing the event loop back between them so the page keeps painting. */
export async function solvePow(address: string, bits: number, onTick: (tried: number) => void = () => {}): Promise<string> {
  const prefix = `${address.toLowerCase()}:`;
  let n = 0;
  for (;;) {
    for (let i = 0; i < 1500; i++) {
      const pow = (n++).toString(36);
      if (leadingZeroBits(keccak256(toUtf8Bytes(prefix + pow))) >= bits) return pow;
    }
    onTick(n);
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** How many 21,000-gas transfers `dripWei` pays for at `feeWei` per gas (base fee + tip). */
export function transfersFor(dripWei: bigint, feeWei: bigint): number {
  if (feeWei <= 0n) return 0;
  return Number(dripWei / (21_000n * feeWei));
}
