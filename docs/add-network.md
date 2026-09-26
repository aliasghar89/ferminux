# Add the network

Chain 3961 is not in wallets' built-in lists yet, so you add it once. It takes one tap
from a Ferminux page, or a minute by hand.

## One tap

Open [ferminux.net/docs](https://ferminux.net/docs/) with MetaMask, Rabby or another
browser wallet installed and use **Add Ferminux to your wallet**, or the add-network
button on the [explorer](https://explorer.ferminux.net). The wallet shows the settings
and asks you to confirm. Nothing is signed or spent.

The [web wallet](https://wallet.ferminux.net) needs no setup: it runs on chain 3961
already, and your keys stay in your browser.

## By hand

MetaMask: **Settings → Networks → Add a network → Add a network manually**. Rabby:
**More → Add custom network**. Other wallets have the same five fields.

| Field | Value |
|---|---|
| Network name | `Ferminux` |
| RPC URL | `https://rpc.ferminux.net` |
| Chain ID | `3961` |
| Currency symbol | `FMX` |
| Block explorer URL | `https://explorer.ferminux.net` |

Other endpoints:

- WebSocket: `wss://rpc.ferminux.net/ws`
- Second HTTPS path to the same service: `https://ferminux.net/rpc`
- Your own node: `http://127.0.0.1:8545` with the same chain ID (see
  [Run a node](run-a-node.md))

## From a dapp

The request that the **Add network** buttons send is the standard EIP-3085 call, whose
method name is fixed by the standard:

```js
await window.ethereum.request({
  method: "wallet_addEthereumChain",
  params: [{
    chainId: "0xF79",
    chainName: "Ferminux",
    nativeCurrency: { name: "Ferminux", symbol: "FMX", decimals: 18 },
    rpcUrls: ["https://rpc.ferminux.net"],
    blockExplorerUrls: ["https://explorer.ferminux.net"],
  }],
});
```

To switch a wallet that already has the network, call `wallet_switchEthereumChain` with
`[{ chainId: "0xF79" }]` and fall back to the call above when it fails with code `4902`.

## Your first FMX

A new address holds nothing, and every transaction costs a little FMX in gas. The faucet
sends **0.5 FMX** to a fresh address, once per address per 24 hours:

```bash
curl -sX POST https://ferminux.net/api/faucet \
  -H 'content-type: application/json' \
  -d '{"address":"0xYourAddress"}'
```

`GET https://ferminux.net/api/faucet` shows its current limits. 0.5 FMX covers thousands
of simple transfers. To buy more, see
[Where does FMX trade?](faq.md#where-does-fmx-trade-and-why)

## Tokens

FMX is the chain's own coin, like the gas coin of any network. Do **not** import it as a
token; it appears as the network balance.

Tokens on the chain are FRC-20 contracts. Import them with **Import tokens** and the
contract address:

| Token | Address | Decimals |
|---|---|---|
| WFMX (wrapped FMX, used by the DEX) | `0x8a9Ae4D652cEba09Db8Ebf48D28C943b41B377Ae` | 18 |
| AZNT (Ferminux Manat) | `0xFc81ad7c145B868ef0CEC8D7Ec881Ac93f724178` | 6 |
| USDF (Ferminux Dollar) | `0xCd032A609e34121D1881E8DE7355b2c2c7092363` | 6 |

Look up any other token on the [explorer](https://explorer.ferminux.net) before adding
it. Anyone can deploy a contract with a familiar name.

## Common messages

**"Chain ID returned by the custom network does not match."** The chain ID or RPC URL is
mistyped. Ferminux is `3961` in decimal and `0xF79` in hex; MetaMask's form wants the
decimal. Check what an endpoint reports:

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
  https://rpc.ferminux.net
# {"jsonrpc":"2.0","id":1,"result":"0xf79"}
```

**"Could not fetch chain ID."** The wallet cannot reach the endpoint. Run the `curl`
above from the same machine. For your own node, make sure it was started with `--http`.

**"The symbol does not match."** Some wallets warn about any chain missing from their
built-in list. `FMX` with 18 decimals is correct; continue.

**The transaction stays pending, or is refused as underpriced.** The tip was below
1 gwei. Chain 3961's signers only include transactions that tip at least 1 gwei. Most wallets ask the network for a tip
and get 1 gwei; if you edited the fee by hand, set the priority fee back to 1 gwei and
use the wallet's speed-up button. More in
[Troubleshooting](troubleshooting.md#my-transaction-stays-pending).

**The base fee shows a few wei.** That is correct. The chain is rarely full, so the base
fee sits near its floor; almost all of what you pay is the 1 gwei tip. A transfer
(21,000 gas) costs about 0.000021 FMX.

**Signatures are rejected.** Signing tools that assume chain 1 produce signatures for
another network. Tell them chain ID 3961 (clef: `--chainid 3961`).
