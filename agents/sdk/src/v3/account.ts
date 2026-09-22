// Addendum v3 — C2 AgentAccount + AgentAccountFactory: policy wallets for
// agents (SPEC.md "## C2", "## G.", "## S.").
//
// `fmx.account` manages accounts on-chain (create/addSession/revoke/execute/
// relay). Two Wallet subclasses implement the `FerminuxWallet` routing the
// spec describes: `SessionAccountWallet` (every tx wrapped through
// `AgentAccount.execute`, caller pays gas) and `GaslessAccountSigner` (every
// tx signed as `executeWithSig` and submitted through the gateway's
// `/api/relay`, so the relayer pays gas).
import { Contract, Interface, Wallet } from "ethers";
import type { Provider, TransactionRequest, TransactionResponse } from "ethers";
import { AGENT_ACCOUNT_ABI, AGENT_ACCOUNT_FACTORY_ABI } from "../abi.js";
import { signExecute } from "../sign.js";
import { lazyContract, toWei, withMinPriorityFee, type AmountLike, type GatewayClient } from "./shared.js";

const ACCOUNT_IFACE = new Interface(AGENT_ACCOUNT_ABI);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Every transaction sent through this wallet is wrapped `AgentAccount.execute(to,value,data)`
 * as a session key (or the account owner) — the caller (this wallet) still pays gas directly. */
export class SessionAccountWallet extends Wallet {
  constructor(
    privateKey: string,
    readonly accountAddress: string,
    provider: Provider,
  ) {
    super(privateKey, provider);
  }

  override async populateTransaction(tx: TransactionRequest): Promise<any> {
    const withFee = await withMinPriorityFee(this.provider as unknown as import("./shared.js").FeeProvider, tx as Record<string, unknown>);
    return super.populateTransaction(withFee as TransactionRequest);
  }

  override async sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
    const to = tx.to as string | undefined;
    if (!to) throw new Error("Ferminux: session-key transactions require a `to` address");
    const value = (tx.value as bigint | undefined) ?? 0n;
    const data = (tx.data as string | undefined) ?? "0x";
    const wrapped: TransactionRequest = {
      ...tx,
      to: this.accountAddress,
      value: 0n,
      data: ACCOUNT_IFACE.encodeFunctionData("execute", [to, value, data]),
    };
    return super.sendTransaction(wrapped);
  }
}

/** Every transaction sent through this wallet is signed as `executeWithSig` and
 * submitted via the gateway's `POST /api/relay` (gas-sponsored, `gasless: true`). */
export class GaslessAccountSigner extends Wallet {
  constructor(
    privateKey: string,
    readonly accountAddress: string,
    provider: Provider,
    private readonly chainId: number,
    private readonly relayFn: (body: Record<string, unknown>) => Promise<{ tx: string }>,
  ) {
    super(privateKey, provider);
  }

  override async sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
    const to = tx.to as string | undefined;
    if (!to) throw new Error("Ferminux: gasless transactions require a `to` address");
    const value = (tx.value as bigint | undefined) ?? 0n;
    const data = (tx.data as string | undefined) ?? "0x";
    const acct = new Contract(this.accountAddress, AGENT_ACCOUNT_ABI, this.provider);
    const nonce: bigint = await acct.nonce();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const sig = await signExecute(this, this.chainId, this.accountAddress, to, value, data, nonce, deadline);
    const { tx: txHash } = await this.relayFn({
      account: this.accountAddress,
      to,
      value: value.toString(),
      data,
      deadline: deadline.toString(),
      sig,
    });
    const provider = this.provider as Provider;
    let resp: TransactionResponse | null = null;
    for (let i = 0; i < 30 && !resp; i++) {
      resp = await provider.getTransaction(txHash);
      if (!resp) await sleep(1000);
    }
    if (!resp) throw new Error(`Ferminux: relayed tx ${txHash} not visible on-chain after 30s`);
    return resp;
  }
}

export class AccountAPI {
  private readonly factory: () => Contract;

  constructor(private readonly fmx: GatewayClient) {
    this.factory = lazyContract("accountFactory", () => this.fmx.v3.accountFactory, AGENT_ACCOUNT_FACTORY_ABI, this.fmx.runner);
  }

  private accountContract(address: string): Contract {
    return new Contract(address, AGENT_ACCOUNT_ABI, this.fmx.runner);
  }

  /** Predicted address for `create(owner, salt)` before it is deployed. */
  async predict(owner: string, salt = "0x0000000000000000000000000000000000000000000000000000000000000000".slice(0, 66)): Promise<string> {
    return this.factory().predict(owner, salt);
  }

  /** Deploys an AgentAccount on-chain (caller pays gas). */
  async create(owner?: string, salt?: string): Promise<{ address: string; tx: string }> {
    const signer = this.fmx.requireSigner();
    const ownerAddr = owner ?? signer.address;
    const saltBytes = salt ?? "0x" + "00".repeat(32);
    const tx = await this.factory().create(ownerAddr, saltBytes);
    const receipt = await tx.wait();
    let address: string | undefined;
    for (const log of receipt.logs ?? []) {
      try {
        const parsed = this.factory().interface.parseLog(log);
        if (parsed?.name === "AccountCreated") {
          address = parsed.args.account as string;
          break;
        }
      } catch {
        // not this contract's event
      }
    }
    if (!address) address = await this.predict(ownerAddr, saltBytes);
    return { address, tx: receipt.hash };
  }

  /** Gasless onboarding: `POST /api/accounts/create` via the gateway relayer (1/owner/day). */
  async createGasless(owner?: string): Promise<{ address: string }> {
    const ownerAddr = owner ?? this.fmx.address;
    if (!ownerAddr) throw new Error("Ferminux: no owner given and no signer configured");
    return this.fmx.gatewayPost("/accounts/create", { owner: ownerAddr });
  }

  async owner(account: string): Promise<string> {
    return this.accountContract(account).owner();
  }

  async sessionInfo(account: string, key: string): Promise<{ capPerDay: bigint; spentToday: bigint; dayStart: bigint; expiry: bigint; anyTarget: boolean }> {
    return this.accountContract(account).sessions(key);
  }

  /** Adds/updates a session key with a daily spend cap (owner only). `targets` empty = anyTarget. */
  async addSession(params: { account: string; key: string; capPerDay: AmountLike; expiry: number; targets?: string[] }): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.accountContract(params.account).addSession(params.key, toWei(params.capPerDay), params.expiry, params.targets ?? []);
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  async revoke(account: string, key: string): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.accountContract(account).revokeSession(key);
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  /** Direct `execute(to,value,data)` call — the configured signer must be the account's
   * owner or an authorized session key of `account`. */
  async execute(params: { account: string; to: string; value?: AmountLike; data?: string }): Promise<{ tx: string; result?: string }> {
    this.fmx.requireSigner();
    const tx = await this.accountContract(params.account).execute(params.to, toWei(params.value ?? 0), params.data ?? "0x");
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  async executeBatch(params: { account: string; calls: Array<{ to: string; value?: AmountLike; data?: string }> }): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const to = params.calls.map((c) => c.to);
    const value = params.calls.map((c) => toWei(c.value ?? 0));
    const data = params.calls.map((c) => c.data ?? "0x");
    const tx = await this.accountContract(params.account).executeBatch(to, value, data);
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  /** Signs `executeWithSig` and relays it through the gateway (`POST /api/relay`) — gas-sponsored. */
  async relay(params: { account: string; to: string; value?: AmountLike; data?: string; deadline?: number }): Promise<{ tx: string }> {
    const signer = this.fmx.requireSigner();
    const value = toWei(params.value ?? 0);
    const data = params.data ?? "0x";
    const nonce: bigint = await this.accountContract(params.account).nonce();
    const deadline = BigInt(params.deadline ?? Math.floor(Date.now() / 1000) + 300);
    const sig = await signExecute(signer, this.fmx.chainId, params.account, params.to, value, data, nonce, deadline);
    return this.fmx.gatewayPost("/relay", {
      account: params.account,
      to: params.to,
      value: value.toString(),
      data,
      deadline: deadline.toString(),
      sig,
    });
  }

  /** Direct (non-gasless) `executeWithSig` call — anyone may broadcast it, `msg.sender` pays gas. */
  async executeWithSig(params: { account: string; to: string; value?: AmountLike; data?: string; deadline?: number }): Promise<{ tx: string }> {
    const signer = this.fmx.requireSigner();
    const value = toWei(params.value ?? 0);
    const data = params.data ?? "0x";
    const nonce: bigint = await this.accountContract(params.account).nonce();
    const deadline = BigInt(params.deadline ?? Math.floor(Date.now() / 1000) + 300);
    const sig = await signExecute(signer, this.fmx.chainId, params.account, params.to, value, data, nonce, deadline);
    const tx = await this.accountContract(params.account).executeWithSig(params.to, value, data, deadline, sig);
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }
}
