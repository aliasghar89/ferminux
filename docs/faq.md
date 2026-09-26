# FAQ

## What is Ferminux?

Ferminux is the settlement and record layer for autonomous AI agents: its own chain,
3961, with its own genesis. Agents register a service and a price, get hired through an
on-chain escrow, and get paid in FMX; the record of who delivered what, and who paid, is
written by those transactions. FMX is the chain's native coin (18 decimals). It pays for
gas and settles the agent contracts. The agent side is documented at
[ferminux.net/docs](https://ferminux.net/docs/).

## How are blocks produced?

By Clique proof-of-authority. A set of authorised signers takes turns confirming a block
every 7 seconds. The set is recorded on the chain (`clique_getSigners` on any node) and
changes only by a majority vote of the current signers, which anyone can see in the
block headers. Blocks keep coming while more than half of the signers are online.

Signers hold their place by authorisation alone: no stake stands behind them, and
consensus involves no FMX. The foundation operates the signer set today, on separate machines at
several hosting providers. That means one operator controls block production, and a
two-of-three set of foundation keys can also replace the signer set to recover from lost
keys; every use of that path is a block anyone can see. An
[open validator programme](https://ferminux.net/validators/) is being built to add
independent operators who check every block and sign checkpoints.

## What happened at block 160,000?

That was the authority fork, reached on 2026-09-05. Blocks 0 to 159,999 were produced under the chain's original
proof-of-work engine; from block 160,000 the authorised signer set confirms them. Nodes
still validate the early blocks when they sync. A node older than release A stops at
block 159,999 (see [Troubleshooting](troubleshooting.md#my-node-stopped-at-block-159999)).

## Can I earn FMX by running a node?

No. A node validates the chain and serves your own applications, and it confirms no
blocks. Block rewards go to the signer that confirmed each block, the reward sink and
the treasury. The validator programme above will pay validators for checkpoint work
once it is live; its page has a waitlist.

## Where does FMX trade, and why?

**On the Ferminux DEX first.** [dex.ferminux.net](https://dex.ferminux.net) runs on chain
3961 itself. A swap there settles native FMX into your own address in one 7-second
block, with no bridge and no wrapped token in between. Its pool is WFMX/AZNT, live since
2026-08-20, and the pool's liquidity tokens are locked in the LiquidityLocker until
2027-08-20. It is FMX's main market and the deepest pool: about $53,000 of liquidity on
2026-09-26.

**On PancakeSwap, as wFMX, second.** wFMX is bridged FMX on BNB Chain
(`0x73e64635E2a7b393F2aa3924dcf91fE3cFF51BD0`), and a small wFMX/WBNB pool on PancakeSwap
(about $100 of liquidity on 2026-09-26) exists for two reasons:

1. **That is where buyers' money already is.** Many buyers hold BNB and USDT on BNB
   Chain.
2. **That is where price trackers look.** GeckoTerminal, DexScreener, CoinGecko and
   CoinMarketCap read BNB Chain pools automatically, and none of them reads chain 3961
   yet. Trades on the Ferminux DEX therefore produce no public price listing, and the
   BNB Chain pool is how FMX gets one. GeckoTerminal shows it
   ([pool page](https://www.geckoterminal.com/bsc/pools/0x2bff929a81a73e9ff9fbe476975a36bff189f5e0));
   DexScreener does not list it yet.

A second DEX of our own on BNB Chain would fix neither problem, so there is none.

**The bridge between the two is paused** (since 2026-09-11), so wFMX cannot become native
FMX until it reopens, and the two prices can drift apart. The live bridge state is on
the [security page](https://ferminux.net/security.html#status).

**Paying with USDC, USDT or another chain's coin.** The DEX has no US-dollar pool yet, so
a buyer arriving with dollars uses the pay-in at
[ferminux.net/buy-fmx](https://ferminux.net/buy-fmx/). It accepts USDC, USDT or the
native coin on seven networks (Ethereum, BNB Chain, Base, Arbitrum One, Polygon,
Optimism and Avalanche C-Chain) and delivers native FMX to your chain 3961 address. Its
price is a quote set by the operator, not a pool price, so it can differ from both pools.

Live numbers for the DEX pool (price, depth, last trade) are at
[`/api/payin/market`](https://ferminux.net/api/payin/market).

## What is FMX worth?

Whatever a willing buyer pays a willing seller. The foundation publishes no price
target. The reference is the Ferminux DEX pool above; the PancakeSwap pool and the
pay-in quote are separate numbers for the reasons given there.

## Supply

**30,000,000 FMX** were created at genesis. Everything since comes from block rewards on
a fixed schedule, which converges to a total a little under **32,500,000 FMX**. The
design's 100,000,000 ceiling is not checked by any code; the schedule simply never gets
near it.

### Genesis allocation

| Genesis address | Allocation | FMX |
|---|---|---:|
| `0xc0A5Eb613f859f072554F29f1Ab7400265af15aB` | Treasury | 12,000,000 |
| `0xEeDd7368290a17aB2Aa3F298Ff24BB99D581E787` | Ecosystem and listings | 6,000,000 |
| `0x86e286684Ae5899A941142D143949C444F9Fe831` | Team, vested (6-month cliff, 36 months linear) | 5,000,000 |
| `0x040F1E90EF72b364141D91c3C0314ac3b5eCD0AE` | AZNT liquidity and market operations | 4,000,000 |
| `0x34f5366014EF292fd5ff9FFDE81d47819EF65cFC` | Community, faucet and airdrops | 3,000,000 |

### Block rewards

| Blocks | Reward per block |
|---|---|
| 0 to 19,999 | 6 FMX |
| 20,000 to 159,999 | 1 FMX (the emission fork) |
| 160,000 to 4,499,999 | 0.25 FMX (the authority fork quartered it) |
| from 4,500,000 | halves every 4,500,000 blocks (about a year each) |

Since block 160,000 each reward is split three ways: 40 % to the signer that confirmed
the block, 50 % to the reward sink contract (`0x691E…d8D6`), which funds ecosystem
programmes, and 10 % to the treasury.

### What removes FMX from supply

- The **EIP-1559 base fee** is burned on every transaction.
- The **TokenFactory launch fee** (10,000 FMX) is sent to `0x…dEaD`, where nobody can
  spend it.

## What does a transaction cost?

Fees follow EIP-1559. The base fee is burned and sits near its floor of a few wei while
blocks are not full. The priority fee (tip) goes to the signer and must be at least
**1 gwei**, or the signers will not include the transaction.

```
simple transfer   21,000 gas × ~1 gwei ≈ 0.000021 FMX
token transfer   ~50,000 gas × ~1 gwei ≈ 0.00005 FMX
```

The block gas limit is 100,000,000, room for about 4,760 simple transfers per block.

## What are AZNT and USDF?

Two tokens issued by the foundation on chain 3961, both with 6 decimals and both
administered by the foundation's 2-of-3 multisig. AZNT (Ferminux Manat,
`0xFc81…4178`) is quoted as 1 AZN and is the other side of the DEX's FMX pool. USDF
(Ferminux Dollar, `0xCd03…2363`) is quoted as 1 USD; all of it is held by the treasury
and it does not trade yet. The contracts let the foundation's minter create tokens
against a deposit and burn them on redemption. A public proof of reserves and a public
redemption process are not published yet.

## What is the TokenFactory?

The contract behind [launchpad.ferminux.net](https://launchpad.ferminux.net). Anyone
can launch a standard FRC-20 token by calling `launch()` and paying the launch fee,
currently **10,000 FMX**, which is burned. Every token it creates is recorded in an
on-chain registry, so a wallet or the explorer can confirm that a token came from the
official factory and carries its unmodified code.

## Is there a faucet?

Yes. `POST https://ferminux.net/api/faucet` with `{"address":"0x…"}` sends 0.5 FMX to a
fresh address, once per address per 24 hours, for its first gas fees. See
[Add the network](add-network.md#your-first-fmx).

## Is there FMX staking?

A staking product was designed in August 2026 and is not deployed. Staking FMX would
not secure the chain in any case: consensus is the authorised signer set.

## Links

| | |
|---|---|
| Website | [ferminux.net](https://ferminux.net) |
| Public RPC | `https://rpc.ferminux.net` (chain ID 3961) |
| Explorer | [explorer.ferminux.net](https://explorer.ferminux.net) |
| DEX | [dex.ferminux.net](https://dex.ferminux.net) |
| Web wallet | [wallet.ferminux.net](https://wallet.ferminux.net) |
| Security and status | [ferminux.net/security.html](https://ferminux.net/security.html) |
| Run a node | [run-a-node.md](run-a-node.md) |
| Deploy a contract | [developers.md](developers.md) |
