import { BrowserProvider, Contract, JsonRpcProvider, type ContractTransactionResponse, type InterfaceAbi, type TransactionReceipt, type Log, type EventLog } from "ethers";
import { CHAIN_PARAMS, config, contractsDeployed, nftDeployed, type AddChainParams } from "./config";
import { CUSTOM_ERROR_TEXT, ESCROW_ABI, NFT_ABI, REGISTRY_ABI } from "./abi";
import type { TypedDataDomain, TypedDataField } from "ethers";

export interface WalletState { address: string | null; chainId: number | null; hasProvider: boolean }
const state: WalletState = { address: null, chainId: null, hasProvider: false };
const listeners = new Set<(s: WalletState) => void>();
let browserProvider: BrowserProvider | null = null;
let readProv: JsonRpcProvider | null = null;

const MOCK = import.meta.env.VITE_MOCK === "1"; // literal so the mock import is tree-shaken in production
let mockAddr: string | null = null;
async function mockWallet() {
  if (!mockAddr) mockAddr = (await import("./mock")).MOCK_WALLET;
  return mockAddr;
}

export const walletState = () => state;
export function onWallet(cb: (s: WalletState) => void) { listeners.add(cb); cb(state); return () => listeners.delete(cb); }
function emit() { listeners.forEach((l) => l({ ...state })); }

export const hasInjected = () => typeof window !== "undefined" && !!window.ethereum;
export const isMobile = () => typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

/** Mobile browsers have no injected wallet: the page must be opened inside the wallet's own browser. */
export function walletDeepLinks() {
  const href = location.href;
  const bare = location.host + location.pathname + location.search;
  return [
    { name: "MetaMask", url: `https://metamask.app.link/dapp/${bare}` },
    { name: "Trust Wallet", url: `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(href)}` },
    { name: "Coinbase Wallet", url: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(href)}` },
  ];
}

/** Small overlay offering to reopen the current page inside a wallet app. */
export function showMobileWalletChooser(): void {
  if (document.getElementById("fmx-wallet-chooser")) return;
  const links = walletDeepLinks();
  const wrap = document.createElement("div");
  wrap.id = "fmx-wallet-chooser";
  wrap.setAttribute("role", "dialog");
  wrap.setAttribute("aria-label", "Open in a wallet app");
  wrap.innerHTML = `
    <div class="fmx-wc-card">
      <h3>Open in your wallet app</h3>
      <p>Mobile browsers cannot talk to a wallet directly. Open this page inside your wallet's browser — it comes back to exactly where you are.</p>
      <div class="fmx-wc-links">
        ${links.map((l) => `<a class="btn btn-primary" href="${l.url}" rel="noopener">${l.name}</a>`).join("")}
      </div>
      <p class="fmx-wc-alt">Or open your wallet app, find its browser, and paste <code>${location.host}${location.pathname}</code>.</p>
      <button type="button" class="btn btn-secondary" data-close>Close</button>
    </div>`;
  wrap.addEventListener("click", (e) => { if (e.target === wrap || (e.target as HTMLElement).closest("[data-close]")) wrap.remove(); });
  document.body.appendChild(wrap);
}

/** MetaMask mobile injects late; wait briefly for it before deciding there is no wallet. */
function waitForInjected(ms = 1500): Promise<boolean> {
  if (hasInjected()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); resolve(hasInjected()); };
    const t = setTimeout(done, ms);
    window.addEventListener("ethereum#initialized", done, { once: true });
  });
}

function errCode(e: any): number | undefined { return e?.code ?? e?.data?.originalError?.code ?? e?.error?.code; }

/** Poll until the wallet reports the target chain (mobile wallets switch a beat after they say they did). */
async function waitForChain(target: number, ms = 8000): Promise<number> {
  const until = Date.now() + ms; let c = 0;
  while (Date.now() < until) {
    try { c = parseInt(await window.ethereum.request({ method: "eth_chainId" }), 16); } catch { /* retry */ }
    if (c === target) return c;
    await new Promise((r) => setTimeout(r, 300));
  }
  return c;
}

export function readProvider(): JsonRpcProvider {
  if (!readProv) readProv = new JsonRpcProvider(config.rpc, config.chainId, { staticNetwork: true });
  return readProv;
}

function attachEvents() {
  const eth = window.ethereum; if (!eth || eth.__fmxBound) return; eth.__fmxBound = true;
  eth.on?.("accountsChanged", (accs: string[]) => { state.address = accs[0] || null; emit(); });
  eth.on?.("chainChanged", (c: string) => { state.chainId = parseInt(c, 16); emit(); });
}

/** Silently pick up an already-authorised account (no prompt). */
export async function restore(): Promise<WalletState> {
  if (MOCK && !hasInjected()) { state.address = await mockWallet(); state.chainId = config.chainId; state.hasProvider = true; emit(); return state; }
  if (!(await waitForInjected())) return state;
  state.hasProvider = true; attachEvents();
  try {
    const accs: string[] = await window.ethereum.request({ method: "eth_accounts" });
    state.address = accs[0] || null;
    const c: string = await window.ethereum.request({ method: "eth_chainId" }); state.chainId = parseInt(c, 16);
  } catch { /* ignore */ }
  emit(); return state;
}

export class WalletError extends Error {}

/** Prompt to connect and make sure the wallet is on chain 3961. */
export async function connect(): Promise<string> {
  if (MOCK && !hasInjected()) { state.address = await mockWallet(); state.chainId = config.chainId; state.hasProvider = true; emit(); return state.address!; }
  if (!(await waitForInjected())) {
    if (isMobile()) { showMobileWalletChooser(); throw new WalletError("Open this page inside your wallet app (MetaMask, Trust Wallet or Coinbase Wallet) to connect."); }
    throw new WalletError("No wallet detected. Install MetaMask (or another EIP-1193 wallet), or use wallet.ferminux.net.");
  }
  state.hasProvider = true; attachEvents();
  let accs: string[];
  try { accs = await window.ethereum.request({ method: "eth_requestAccounts" }); }
  catch (e) {
    if (errCode(e) === -32002) throw new WalletError("A connection request is already open in your wallet — switch to the wallet app and approve it.");
    throw new WalletError(errMessage(e, "Connection request was rejected in the wallet."));
  }
  if (!accs?.length) throw new WalletError("The wallet returned no account.");
  state.address = accs[0];
  await ensureChain();
  browserProvider = new BrowserProvider(window.ethereum);
  emit(); return state.address;
}

export async function ensureChain(): Promise<void> {
  if (MOCK && !hasInjected()) return;
  const current: string = await window.ethereum.request({ method: "eth_chainId" });
  state.chainId = parseInt(current, 16);
  if (state.chainId === config.chainId) return;
  const addChain = async () => {
    try { await window.ethereum.request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS] }); }
    catch (e2) {
      if (errCode(e2) === -32002) throw new WalletError("The wallet is already asking you to add Ferminux Network — approve it in the wallet app, then try again.");
      throw new WalletError(errMessage(e2, "Adding Ferminux Network to the wallet was rejected."));
    }
  };
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: config.chainIdHex }] });
  } catch (e: any) {
    const code = errCode(e);
    if (code === 4902 || code === -32603 || /unrecognized|not added|add(ed)? this chain|Unrecognized chain/i.test(String(e?.message))) {
      await addChain();
      // Some mobile wallets add without switching; ask once more, ignoring "already pending".
      if ((await waitForChain(config.chainId, 2500)) !== config.chainId) {
        try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: config.chainIdHex }] }); } catch { /* handled by the wait below */ }
      }
    } else if (code === -32002) {
      throw new WalletError("The wallet is already asking you to switch networks — approve it in the wallet app, then try again.");
    } else throw new WalletError(errMessage(e, "Switching to Ferminux Network was rejected."));
  }
  state.chainId = await waitForChain(config.chainId);
  if (state.chainId !== config.chainId) throw new WalletError("The wallet is not on Ferminux Network (chain 3961) yet. Switch networks in the wallet and try again.");
  emit();
}

/* ==================== other EVM chains (pay-in on BNB Chain / Base) ==================== */

/** Connect (prompt) WITHOUT switching to 3961 — for flows that transact on another chain first (pay-in). */
export async function connectAnyChain(): Promise<string> {
  if (MOCK && !hasInjected()) { state.address = await mockWallet(); state.chainId = config.chainId; state.hasProvider = true; emit(); return state.address!; }
  if (!(await waitForInjected())) {
    if (isMobile()) { showMobileWalletChooser(); throw new WalletError("Open this page inside your wallet app (MetaMask, Trust Wallet or Coinbase Wallet) to connect."); }
    throw new WalletError("No wallet detected. Install MetaMask (or another EIP-1193 wallet), or send the payment manually from any wallet.");
  }
  state.hasProvider = true; attachEvents();
  let accs: string[];
  try { accs = await window.ethereum.request({ method: "eth_requestAccounts" }); }
  catch (e) {
    if (errCode(e) === -32002) throw new WalletError("A connection request is already open in your wallet — switch to the wallet app and approve it.");
    throw new WalletError(errMessage(e, "Connection request was rejected in the wallet."));
  }
  if (!accs?.length) throw new WalletError("The wallet returned no account.");
  state.address = accs[0];
  try { state.chainId = parseInt(await window.ethereum.request({ method: "eth_chainId" }), 16); } catch { /* ignore */ }
  browserProvider = new BrowserProvider(window.ethereum);
  emit(); return state.address;
}

/**
 * Switch the injected wallet to `chainId` (e.g. 56 BNB Chain, 8453 Base); when the wallet does not know
 * the chain, `wallet_addEthereumChain` with `params` and switch again. Resolves once the wallet reports it.
 */
export async function switchToChain(chainId: number, params: AddChainParams): Promise<void> {
  if (!hasInjected()) throw new WalletError("No wallet detected.");
  const hex = "0x" + chainId.toString(16);
  let current = 0;
  try { current = parseInt(await window.ethereum.request({ method: "eth_chainId" }), 16); } catch { /* ask anyway */ }
  if (current !== chainId) {
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e: any) {
      const code = errCode(e);
      if (code === 4902 || code === -32603 || /unrecognized|not added|add(ed)? this chain|Unrecognized chain/i.test(String(e?.message))) {
        try { await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{ ...params, chainId: hex }] }); }
        catch (e2) {
          if (errCode(e2) === -32002) throw new WalletError(`The wallet is already asking you to add ${params.chainName} — approve it in the wallet app, then try again.`);
          throw new WalletError(errMessage(e2, `Adding ${params.chainName} to the wallet was rejected.`));
        }
        if ((await waitForChain(chainId, 2500)) !== chainId) {
          try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }); } catch { /* handled by the wait below */ }
        }
      } else if (code === -32002) {
        throw new WalletError("The wallet is already asking you to switch networks — approve it in the wallet app, then try again.");
      } else throw new WalletError(errMessage(e, `Switching to ${params.chainName} was rejected.`));
    }
  }
  state.chainId = await waitForChain(chainId);
  if (state.chainId !== chainId) throw new WalletError(`The wallet is not on ${params.chainName} yet. Switch networks in the wallet and try again.`);
  emit();
}

/**
 * Raw `eth_sendTransaction` through the injected provider on whatever chain it is on (the wallet estimates
 * gas and picks fees). Returns the tx hash; every failure becomes a plain-language WalletError.
 */
export async function sendRawTransaction(tx: { to: string; value?: bigint; data?: string }): Promise<string> {
  if (!hasInjected()) throw new WalletError("No wallet detected.");
  const from = state.address || (await connectAnyChain());
  const params: Record<string, string> = { from, to: tx.to };
  if (tx.value !== undefined && tx.value > 0n) params.value = "0x" + tx.value.toString(16);
  if (tx.data && tx.data !== "0x") params.data = tx.data;
  let hash: string;
  try { hash = await window.ethereum.request({ method: "eth_sendTransaction", params: [params] }); }
  catch (e) { throw new WalletError(errMessage(e, "The wallet did not send the transaction.")); }
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new WalletError("The wallet returned an unexpected transaction hash.");
  return hash;
}

/**
 * Raw `eth_call` through the injected provider on whatever chain it is currently on — used for pay-in
 * preflight balance checks on external (non-3961) chains, where `readProvider()`/`getBalance` don't apply.
 */
export async function ethCall(to: string, data: string): Promise<string> {
  if (!hasInjected()) throw new WalletError("No wallet detected.");
  return window.ethereum.request({ method: "eth_call", params: [{ to, data }, "latest"] });
}

/** Native-coin balance (wei) of `address` on whatever chain the injected provider is currently on. */
export async function nativeBalanceOf(address: string): Promise<bigint> {
  if (!hasInjected()) throw new WalletError("No wallet detected.");
  const hex: string = await window.ethereum.request({ method: "eth_getBalance", params: [address, "latest"] });
  return BigInt(hex);
}

export async function addNetwork(): Promise<void> {
  if (!hasInjected()) throw new WalletError("No wallet detected. Install MetaMask, or use wallet.ferminux.net.");
  await window.ethereum.request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS] });
}

export async function signer() {
  if (!state.address) await connect();
  await ensureChain();
  if (!browserProvider) browserProvider = new BrowserProvider(window.ethereum);
  const s = await browserProvider.getSigner();
  // Ferminux signers keep geth's 1 gwei tip floor while the base fee is a few
  // wei; a wallet that follows raw fee history can suggest a 1 wei tip and the
  // tx never confirms. Suggest explicit fees so the wallet starts from a
  // confirmable value (users can still edit them in the wallet UI).
  const send = s.sendTransaction.bind(s);
  s.sendTransaction = async (tx) => {
    if (tx.gasPrice == null && tx.maxFeePerGas == null && tx.maxPriorityFeePerGas == null) {
      const tip = 1_000_000_000n;
      const block = await readProvider().getBlock("latest").catch(() => null);
      const base = block?.baseFeePerGas ?? 0n;
      tx = { ...tx, maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip };
    }
    return send(tx);
  };
  return s;
}

/** EIP-191 personal_sign of a UTF-8 message (gas-free; used by the forum and inbox). */
export async function personalSign(message: string, address?: string): Promise<string> {
  if (MOCK && !hasInjected()) {
    await new Promise((r) => setTimeout(r, 500));
    return "0x" + Array.from(crypto.getRandomValues(new Uint8Array(65))).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  if (!hasInjected()) throw new WalletError("No wallet detected. Install MetaMask (or another EIP-1193 wallet) to sign.");
  const from = address || state.address || (await connect());
  try {
    const hex = "0x" + Array.from(new TextEncoder().encode(message)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const sig: string = await window.ethereum.request({ method: "personal_sign", params: [hex, from] });
    if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new WalletError("The wallet returned an unexpected signature.");
    return sig;
  } catch (e) { throw new WalletError(errMessage(e, "Signing was rejected in the wallet.")); }
}

export function requireContracts() {
  if (!contractsDeployed) throw new WalletError("The registry and escrow contracts are not deployed yet. Addresses will appear here once they are live.");
}

export const registryRead = () => new Contract(config.registry, REGISTRY_ABI, readProvider());
export const escrowRead = () => new Contract(config.escrow, ESCROW_ABI, readProvider());
export const registryWrite = async () => new Contract(config.registry, REGISTRY_ABI, await signer());
export const escrowWrite = async () => new Contract(config.escrow, ESCROW_ABI, await signer());
export const nftRead = () => new Contract(config.nft, NFT_ABI, readProvider());
export const nftWrite = async () => new Contract(config.nft, NFT_ABI, await signer());
export function requireNft() {
  if (!nftDeployed) throw new WalletError("The Ferminux Agents collection is not deployed yet.");
}

// ---------- reads used by pages (mock-aware) ----------
export async function getMinBond(): Promise<bigint> {
  if (MOCK) return 100n * 10n ** 18n;
  requireContracts(); return registryRead().minBond();
}
export async function getCredits(addr: string): Promise<bigint> {
  if (MOCK) return 37n * 10n ** 17n; // 3.7 FMX
  requireContracts(); return escrowRead().credits(addr);
}
export async function getAgentOnChain(id: number): Promise<{ retiredAt: bigint; status: number; bond: bigint }> {
  if (MOCK) return { retiredAt: 0n, status: 1, bond: 100n * 10n ** 18n };
  requireContracts(); const a = await registryRead().getAgent(id);
  return { retiredAt: BigInt(a.retiredAt), status: Number(a.status), bond: BigInt(a.bond) };
}
export async function getBalance(addr: string): Promise<bigint> {
  if (MOCK) return 2519n * 10n ** 17n;
  return readProvider().getBalance(addr);
}

// ---------- tx helper ----------
export type TxPhase = "signing" | "pending" | "confirmed" | "indexing" | "failed";

/**
 * The gateway indexes the chain a block or two behind the head. Every page re-reads the gateway
 * right after a transaction confirms, which used to show stale state ("No plans yet" right after
 * creating one). Wait (bounded) until /health reports indexedBlock >= the receipt's block.
 */
export async function awaitIndexed(block: number | null | undefined, timeoutMs = 25000): Promise<boolean> {
  if (!block || MOCK) return true;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(config.gateway + "/health", { headers: { accept: "application/json" } });
      if (r.ok) { const h = await r.json(); if (Number(h.indexedBlock) >= block) return true; }
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 1500));
  }
  return false;
}
/** Poll `read` until `ok(result)` or the timeout; returns the last result. For gateway rows that have no block to wait on (relayed writes). */
export async function pollUntil<T>(read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 25000, everyMs = 1500): Promise<T> {
  const until = Date.now() + timeoutMs; let last = await read();
  while (!ok(last) && Date.now() < until) { await new Promise((r) => setTimeout(r, everyMs)); last = await read(); }
  return last;
}
export interface TxResult { hash: string; receipt: TransactionReceipt | null; logs: (Log | EventLog)[] }

/**
 * Runs a contract call: prompts the wallet, waits for 1 confirmation, reports phases.
 * Every failure is turned into a plain-language Error.
 */
export async function sendTx(run: (c: { registry: Contract; escrow: Contract; nft: Contract }) => Promise<ContractTransactionResponse>, onPhase?: (p: TxPhase, hash?: string) => void): Promise<TxResult> {
  if (MOCK && !hasInjected()) {
    onPhase?.("signing"); await new Promise((r) => setTimeout(r, 600));
    const hash = "0x" + Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("");
    onPhase?.("pending", hash); await new Promise((r) => setTimeout(r, 1200)); onPhase?.("confirmed", hash);
    return { hash, receipt: null, logs: [] };
  }
  requireContracts();
  const registry = await registryWrite(); const escrow = await escrowWrite(); const nft = await nftWrite();
  onPhase?.("signing");
  let tx: ContractTransactionResponse;
  try { tx = await run({ registry, escrow, nft }); }
  catch (e) { onPhase?.("failed"); throw new WalletError(errMessage(e)); }
  onPhase?.("pending", tx.hash);
  let receipt: TransactionReceipt | null;
  try { receipt = await tx.wait(1); }
  catch (e) { onPhase?.("failed", tx.hash); throw new WalletError(errMessage(e, "The transaction was confirmed but reverted.")); }
  if (!receipt || receipt.status !== 1) { onPhase?.("failed", tx.hash); throw new WalletError("The transaction reverted on chain. Nothing was charged except gas."); }
  onPhase?.("confirmed", tx.hash);
  onPhase?.("indexing", tx.hash); await awaitIndexed(receipt.blockNumber);
  // decode logs against every ABI we know
  const logs: (Log | EventLog)[] = receipt.logs.map((l) => {
    for (const c of [registry, escrow, nft]) {
      try { const p = c.interface.parseLog({ topics: [...l.topics], data: l.data }); if (p) return Object.assign(l, { fragment: p.fragment, args: p.args, eventName: p.name }); } catch { /* next */ }
    }
    return l;
  });
  return { hash: tx.hash, receipt, logs };
}

export function eventArg(logs: (Log | EventLog)[], name: string, arg: string): unknown {
  for (const l of logs) { const e = l as EventLog; if (e.eventName === name && e.args) { try { return e.args[arg]; } catch { /* fallthrough */ } } }
  return undefined;
}

/* ==================== Addendum v3 — generic contract helpers ==================== */
// New contracts (vault, accounts, streams, arbiter pool, ERC-8004 adapters, token factory) each get
// their own page; rather than growing sendTx's fixed {registry,escrow,nft} triad, these two helpers
// build a read or write Contract for any address+ABI, and sendCall runs one write with the same
// phase reporting / plain-language errors as sendTx.
export const contractRead = (addr: string, abi: InterfaceAbi) => new Contract(addr, abi, readProvider());
export async function contractWrite(addr: string, abi: InterfaceAbi) { return new Contract(addr, abi, await signer()); }

export async function sendCall(contract: Contract, fn: string, args: unknown[] = [], overrides: Record<string, unknown> = {}, onPhase?: (p: TxPhase, hash?: string) => void): Promise<TxResult> {
  if (MOCK && !hasInjected()) {
    onPhase?.("signing"); await new Promise((r) => setTimeout(r, 600));
    const hash = "0x" + Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("");
    onPhase?.("pending", hash); await new Promise((r) => setTimeout(r, 1200)); onPhase?.("confirmed", hash);
    return { hash, receipt: null, logs: [] };
  }
  onPhase?.("signing");
  let tx: ContractTransactionResponse;
  try { tx = await (contract as unknown as Record<string, (...a: unknown[]) => Promise<ContractTransactionResponse>>)[fn](...args, overrides); }
  catch (e) { onPhase?.("failed"); throw new WalletError(errMessage(e)); }
  onPhase?.("pending", tx.hash);
  let receipt: TransactionReceipt | null;
  try { receipt = await tx.wait(1); }
  catch (e) { onPhase?.("failed", tx.hash); throw new WalletError(errMessage(e, "The transaction was confirmed but reverted.")); }
  if (!receipt || receipt.status !== 1) { onPhase?.("failed", tx.hash); throw new WalletError("The transaction reverted on chain. Nothing was charged except gas."); }
  onPhase?.("confirmed", tx.hash);
  onPhase?.("indexing", tx.hash); await awaitIndexed(receipt.blockNumber);
  const logs: (Log | EventLog)[] = receipt.logs.map((l) => {
    try { const p = contract.interface.parseLog({ topics: [...l.topics], data: l.data }); if (p) return Object.assign(l, { fragment: p.fragment, args: p.args, eventName: p.name }); } catch { /* not this contract's log */ }
    return l;
  });
  return { hash: tx.hash, receipt, logs };
}

/** EIP-712 typed-data signature (used by /x402/ vouchers). Falls back to a fake sig in mock mode without an injected wallet. */
export async function signTyped(domain: TypedDataDomain, types: Record<string, TypedDataField[]>, value: Record<string, unknown>): Promise<string> {
  if (MOCK && !hasInjected()) { await new Promise((r) => setTimeout(r, 400)); return "0x" + Array.from(crypto.getRandomValues(new Uint8Array(65))).map((b) => b.toString(16).padStart(2, "0")).join(""); }
  const s = await signer();
  try { return await s.signTypedData(domain, types, value); }
  catch (e) { throw new WalletError(errMessage(e, "Signing the voucher was rejected in the wallet.")); }
}

/** Map wallet / RPC / contract errors to plain language. */
export function errMessage(e: unknown, fallback = "Something went wrong."): string {
  const err = e as any;
  if (!err) return fallback;
  if (err instanceof WalletError) return err.message;
  const code = err.code ?? err.info?.error?.code ?? err.error?.code;
  const msg: string = String(err.shortMessage || err.reason || err.info?.error?.message || err.error?.message || err.message || "");
  if (code === 4001 || code === "ACTION_REJECTED" || /user rejected|user denied/i.test(msg)) return "You rejected the request in the wallet. Nothing was sent.";
  if (code === "INSUFFICIENT_FUNDS" || /insufficient funds/i.test(msg)) return "Not enough FMX in the wallet for this amount plus gas. Get gas from the faucet or top up at wallet.ferminux.net.";
  if (code === "CALL_EXCEPTION" || /execution reverted|revert/i.test(msg)) {
    // ethers v6 decodes custom errors (when the ABI carries them) into err.revert = { name, args }
    const rv = err.revert as { name?: string; args?: unknown[] } | null | undefined;
    if (rv?.name) {
      const t = CUSTOM_ERROR_TEXT[rv.name];
      const text = typeof t === "function" ? t([...(rv.args ?? [])].map((a) => (typeof a === "bigint" ? a.toString() : a))) : t;
      return text ? `The contract rejected this action: ${text}` : `The contract rejected this action (${rv.name}).`;
    }
    const reason = err.reason || (msg.match(/reverted:? ?"?([^"]+)"?/)?.[1] ?? "");
    const r = reason && !/^execution reverted$/i.test(reason) ? ` The contract said: "${reason.replace(/^execution reverted:?\s*/i, "")}".` : "";
    return "The contract rejected this action." + (r || " Check that you are using the right wallet and that the amounts and state are what the contract expects.");
  }
  if (code === "NETWORK_ERROR" || /network error|failed to fetch|could not detect network/i.test(msg)) return "Cannot reach the Ferminux RPC. Check your connection and try again.";
  if (code === -32002 || /already pending/i.test(msg)) return "The wallet already has a pending request. Open it and finish or dismiss that first.";
  if (/nonce/i.test(msg)) return "Nonce problem in the wallet. Reset the account's activity in MetaMask settings, then retry.";
  if (msg) return msg.length > 220 ? msg.slice(0, 220) + "…" : msg;
  return fallback;
}
