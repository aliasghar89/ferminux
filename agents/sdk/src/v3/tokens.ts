// Addendum v3 — C6 AgentTokenFactory: agent tokens on a bonding curve (SPEC.md "## C6", "## S.").
import { Contract } from "ethers";
import { AGENT_TOKEN_ABI, AGENT_TOKEN_FACTORY_ABI } from "../abi.js";
import { findEventArgs, lazyContract, toWei, type AmountLike, type GatewayClient } from "./shared.js";

export class TokensAPI {
  private readonly contract: () => Contract;

  constructor(private readonly fmx: GatewayClient) {
    this.contract = lazyContract("tokenFactory", () => this.fmx.v3.tokenFactory, AGENT_TOKEN_FACTORY_ABI, this.fmx.runner);
  }

  /** Launches the agent's (one, ever) FRC-20 on a linear bonding curve priced in FMX. Agent owner only. */
  async launch(params: { agentId: number | bigint; symbol: string; base: AmountLike; slope: AmountLike }): Promise<{ token: string; tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().launch(params.agentId, params.symbol, toWei(params.base), toWei(params.slope));
    const receipt = await tx.wait();
    const args = findEventArgs(this.contract(), receipt, "Launched");
    if (!args) throw new Error("Ferminux: Launched event not found in receipt");
    return { token: args.token as string, tx: receipt.hash };
  }

  async buy(params: { token: string; fmxIn: AmountLike; minOut?: AmountLike }): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().buy(params.token, toWei(params.minOut ?? 0), { value: toWei(params.fmxIn) });
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  /** Sell proceeds are pull-payment (CEI-safe, like every FMX-out path in Addendum v3) — withdraw with `credits()`/`withdraw()`. */
  async sell(params: { token: string; amount: AmountLike; minFmx?: AmountLike }): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().sell(params.token, toWei(params.amount), toWei(params.minFmx ?? 0));
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  /** Pull-payment credits: sell proceeds land here first (see `sell()`). */
  async credits(address?: string): Promise<bigint> {
    const addr = address ?? this.fmx.requireSigner().address;
    return this.contract().credits(addr);
  }

  async withdraw(): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().withdraw();
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  async quoteBuy(token: string, fmxIn: AmountLike): Promise<bigint> {
    return this.contract().quoteBuy(token, toWei(fmxIn));
  }

  async quoteSell(token: string, amountIn: AmountLike): Promise<bigint> {
    return this.contract().quoteSell(token, toWei(amountIn));
  }

  /** Agent owner shares FMX pro-rata to holders (pull via `claimDistribution`). */
  async distribute(token: string, amount: AmountLike): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().distribute(token, { value: toWei(amount) });
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  async claimDistribution(token: string): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().claimDistribution(token);
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  async tokenOf(agentId: number | bigint): Promise<string> {
    return this.contract().tokenOf(agentId);
  }

  /** Reads an AgentToken's FRC-20 basics + the caller's balance (or `holder`). */
  async info(token: string, holder?: string): Promise<{ name: string; symbol: string; decimals: number; totalSupply: bigint; balance: bigint | null }> {
    const erc20 = new Contract(token, AGENT_TOKEN_ABI, this.fmx.runner);
    const [name, symbol, decimals, totalSupply] = await Promise.all([erc20.name(), erc20.symbol(), erc20.decimals(), erc20.totalSupply()]);
    const addr = holder ?? this.fmx.address;
    const balance = addr ? ((await erc20.balanceOf(addr)) as bigint) : null;
    return { name, symbol: symbol as string, decimals: Number(decimals), totalSupply, balance };
  }
}
