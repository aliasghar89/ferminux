// Gas sponsorship: the gateway relays AgentAccount.executeWithSig (owner or
// session-key signed) and AgentAccountFactory.create, paying gas from
// RELAYER_KEY. Limits: 20 relays/account/day, gas ≤ 300k, `to` must be one
// of the Ferminux contracts (registry, escrow, vault, streams, arbiter,
// 8004 registries, token factory). 1 account creation per owner per day.
// Owners and accounts are free to mint, so per-subject limits alone let one
// client drain the relayer: per-IP and global daily caps sit on top
// (RELAY_MAX_PER_DAY / ACCOUNT_CREATE_MAX_PER_DAY env).
import type { FastifyInstance } from "fastify";
import { Contract, getAddress, isHexString, keccak256, toUtf8Bytes, zeroPadValue } from "ethers";
import { HttpError } from "../commons/context.js";
import { V3_CONTRACT_KEYS, type V3ContractKey } from "../config.js";
import { DISABLED_NOT_DEPLOYED, dayStart, type V3Context } from "./context.js";

export const RELAY_MAX_GAS = 300_000n;
export const RELAY_PER_ACCOUNT_PER_DAY = 20;
export const ACCOUNT_CREATE_PER_OWNER_PER_DAY = 1;
export const RELAY_PRIORITY_FEE_WEI = 1_000_000_000n; // signers require a 1 gwei tip
export const RELAY_PER_IP_PER_DAY = 100;
export const RELAY_MAX_PER_DAY = Number(process.env.RELAY_MAX_PER_DAY || 2000);
export const ACCOUNT_CREATE_PER_IP_PER_DAY = 5;
export const ACCOUNT_CREATE_MAX_PER_DAY = Number(process.env.ACCOUNT_CREATE_MAX_PER_DAY || 200);

export function allowedTargets(ctx: V3Context): Record<string, string> {
  const out: Record<string, string> = { registry: ctx.cfg.registry, escrow: ctx.cfg.escrow };
  for (const key of V3_CONTRACT_KEYS as readonly V3ContractKey[]) {
    if (key === "accountImpl") continue;
    const a = ctx.address(key);
    if (a) out[key] = a;
  }
  return out;
}

export function registerRelayRoutes(app: FastifyInstance, ctx: V3Context): void {
  const { db, commons } = ctx;
  const countStmt = db.prepare("SELECT COUNT(*) AS c FROM relays WHERE kind = ? AND lower(subject) = lower(?) AND createdAt >= ? AND ok = 1");
  const countIpStmt = db.prepare("SELECT COUNT(*) AS c FROM relays WHERE kind = ? AND ip = ? AND createdAt >= ? AND ok = 1");
  const countAllStmt = db.prepare("SELECT COUNT(*) AS c FROM relays WHERE kind = ? AND createdAt >= ? AND ok = 1");
  const insertStmt = db.prepare("INSERT INTO relays (kind, subject, target, txHash, ok, error, gasLimit, createdAt, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  /** per-IP + global day caps (429 / 503); `used` is the per-subject count the caller already has */
  function checkCaps(kind: "relay" | "create", ip: string, day: number, perIp: number, global: number): void {
    if ((countIpStmt.get(kind, ip, day) as { c: number }).c >= perIp) throw new HttpError(429, `${kind} limit for this IP reached today (${perIp})`, "rate_limited");
    if ((countAllStmt.get(kind, day) as { c: number }).c >= global) throw new HttpError(503, `${kind} sponsorship is exhausted for today (${global}) — send the transaction yourself`, "daily_cap");
  }

  function relayerStatus(reply: import("fastify").FastifyReply, ...keys: V3ContractKey[]): boolean {
    if (!ctx.requireDeployed(reply, ...keys)) return false;
    if (!ctx.relayer) {
      void reply.code(503).send({ disabled: true, reason: "relayer disabled (RELAYER_KEY unset)" });
      return false;
    }
    return true;
  }

  app.post("/api/relay", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    try {
      if (!relayerStatus(reply, "accountImpl")) return reply;
      const body = commons.parseJson(req);
      let account: string;
      let to: string;
      try {
        account = getAddress(String(body.account));
        to = getAddress(String(body.to));
      } catch {
        throw new HttpError(400, "account and to must be 0x addresses");
      }
      const targets = allowedTargets(ctx);
      const allowed = Object.values(targets).map((a) => a.toLowerCase());
      if (!allowed.includes(to.toLowerCase())) throw new HttpError(403, `to must be a Ferminux contract: ${Object.entries(targets).map(([k, v]) => `${k}=${v}`).join(", ")}`, "target_not_allowed");
      const value = BigInt(commons.checkWei(body.value ?? "0", "value", false));
      const data = typeof body.data === "string" && isHexString(body.data) ? body.data : body.data === undefined || body.data === "" ? "0x" : null;
      if (data === null) throw new HttpError(400, "data must be 0x hex");
      const deadline = Number(body.deadline);
      if (!Number.isInteger(deadline) || deadline <= ctx.nowS()) throw new HttpError(400, "deadline must be a future unix timestamp");
      const sig = body.sig;
      if (typeof sig !== "string" || !isHexString(sig) || sig.length < 132) throw new HttpError(400, "sig must be a 0x hex EIP-712 signature (FerminuxAgentAccount Execute)");
      const t = ctx.nowS();
      const ip = String(req.ip || "?");
      const used = (countStmt.get("relay", account, dayStart(t)) as { c: number }).c;
      if (used >= RELAY_PER_ACCOUNT_PER_DAY) throw new HttpError(429, `relay limit: ${RELAY_PER_ACCOUNT_PER_DAY} per account per day`, "rate_limited");
      checkCaps("relay", ip, dayStart(t), RELAY_PER_IP_PER_DAY, RELAY_MAX_PER_DAY);

      const acct = new Contract(account, ctx.iface("accountImpl").fragments, ctx.relayer!);
      const code = await ctx.provider.getCode(account).catch(() => "0x");
      if (code === "0x") throw new HttpError(404, "account has no code (create it via POST /api/accounts/create)");
      // only clones our factory deployed get sponsored gas — any other contract with an executeWithSig() could burn the 300k cap per call
      const factory = ctx.contract("accountFactory");
      if (factory) {
        const known = db.prepare("SELECT 1 FROM agent_accounts WHERE lower(account) = lower(?)").get(account) || (await factory.isAccount(account).catch(() => false));
        if (!known) throw new HttpError(403, "account was not created by the Ferminux AgentAccountFactory", "target_not_allowed");
      }
      let gas: bigint;
      try {
        gas = (await acct.executeWithSig.estimateGas(to, value, data, deadline, sig)) as bigint;
      } catch (err) {
        insertStmt.run("relay", account, to, null, 0, (err as Error).message.slice(0, 200), null, t, ip);
        throw new HttpError(400, `executeWithSig would revert: ${(err as Error).message.slice(0, 160)}`);
      }
      if (gas > RELAY_MAX_GAS) throw new HttpError(400, `gas ${gas} exceeds the ${RELAY_MAX_GAS} relay cap`);
      const fee = await ctx.provider.getFeeData();
      const tx = await acct.executeWithSig(to, value, data, deadline, sig, {
        gasLimit: RELAY_MAX_GAS,
        maxPriorityFeePerGas: RELAY_PRIORITY_FEE_WEI,
        maxFeePerGas: (fee.maxFeePerGas ?? fee.gasPrice ?? RELAY_PRIORITY_FEE_WEI * 2n) < RELAY_PRIORITY_FEE_WEI ? RELAY_PRIORITY_FEE_WEI * 2n : (fee.maxFeePerGas ?? fee.gasPrice ?? RELAY_PRIORITY_FEE_WEI * 2n),
      });
      insertStmt.run("relay", account, to, tx.hash, 1, null, Number(RELAY_MAX_GAS), t, ip);
      return reply.code(202).send({ txHash: tx.hash, tx: tx.hash, account, to, value: value.toString(), gasEstimate: gas.toString(), gasLimit: RELAY_MAX_GAS.toString(), relayer: ctx.relayer!.address, remainingToday: RELAY_PER_ACCOUNT_PER_DAY - used - 1 });
    } catch (err) {
      return commons.sendError(reply, err);
    }
  });

  app.post("/api/accounts/create", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    try {
      if (!relayerStatus(reply, "accountFactory")) return reply;
      const body = commons.parseJson(req);
      let owner: string;
      try {
        owner = getAddress(String(body.owner));
      } catch {
        throw new HttpError(400, "owner must be a 0x address");
      }
      let salt: string;
      if (body.salt === undefined || body.salt === null || body.salt === "") salt = zeroPadValue("0x00", 32);
      else if (typeof body.salt === "string" && isHexString(body.salt) && body.salt.length <= 66) salt = zeroPadValue(body.salt, 32);
      else if (typeof body.salt === "string") salt = keccak256(toUtf8Bytes(body.salt));
      else throw new HttpError(400, "salt must be a hex bytes32 or a string");
      const factory = ctx.contract("accountFactory")!;
      const predicted = getAddress((await factory.predict(owner, salt)) as string);
      const code = await ctx.provider.getCode(predicted).catch(() => "0x");
      if (code !== "0x") return { account: predicted, owner, salt, existing: true, txHash: null };
      const t = ctx.nowS();
      const ip = String(req.ip || "?");
      const used = (countStmt.get("create", owner, dayStart(t)) as { c: number }).c;
      if (used >= ACCOUNT_CREATE_PER_OWNER_PER_DAY) throw new HttpError(429, `account creation limit: ${ACCOUNT_CREATE_PER_OWNER_PER_DAY} per owner per day`, "rate_limited");
      checkCaps("create", ip, dayStart(t), ACCOUNT_CREATE_PER_IP_PER_DAY, ACCOUNT_CREATE_MAX_PER_DAY);
      const signer = factory.connect(ctx.relayer!) as Contract;
      const fee = await ctx.provider.getFeeData();
      const tx = await signer.create(owner, salt, { maxPriorityFeePerGas: RELAY_PRIORITY_FEE_WEI, maxFeePerGas: (fee.maxFeePerGas ?? fee.gasPrice ?? RELAY_PRIORITY_FEE_WEI * 2n) < RELAY_PRIORITY_FEE_WEI ? RELAY_PRIORITY_FEE_WEI * 2n : (fee.maxFeePerGas ?? fee.gasPrice ?? RELAY_PRIORITY_FEE_WEI * 2n) });
      insertStmt.run("create", owner, predicted, tx.hash, 1, null, null, t, ip);
      return reply.code(202).send({ account: predicted, owner, salt, existing: false, txHash: tx.hash, tx: tx.hash, relayer: ctx.relayer!.address });
    } catch (err) {
      return commons.sendError(reply, err);
    }
  });

  app.get("/api/relay", async () => ({
    ...(ctx.deployed("accountImpl") ? {} : DISABLED_NOT_DEPLOYED),
    enabled: !!ctx.relayer && ctx.deployed("accountImpl"),
    relayer: ctx.relayer?.address ?? null,
    factory: ctx.address("accountFactory") ?? null,
    implementation: ctx.address("accountImpl") ?? null,
    limits: { relaysPerAccountPerDay: RELAY_PER_ACCOUNT_PER_DAY, relaysPerIpPerDay: RELAY_PER_IP_PER_DAY, relaysPerDay: RELAY_MAX_PER_DAY, maxGas: Number(RELAY_MAX_GAS), accountCreatesPerOwnerPerDay: ACCOUNT_CREATE_PER_OWNER_PER_DAY, accountCreatesPerIpPerDay: ACCOUNT_CREATE_PER_IP_PER_DAY, accountCreatesPerDay: ACCOUNT_CREATE_MAX_PER_DAY },
    allowedTargets: allowedTargets(ctx),
    signing: { domain: { name: "FerminuxAgentAccount", version: "1", chainId: 3961, verifyingContract: "<account>" }, primaryType: "Execute", fields: "(to, value, keccak256(data), nonce, deadline)" },
  }));
}
