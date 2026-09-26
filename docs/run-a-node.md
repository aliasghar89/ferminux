# Run a node

A Ferminux node downloads every block of chain 3961, re-executes it and checks the
signature of the signer that confirmed it. Run one when you want to read the chain
without trusting someone else's RPC, serve your own applications, or help the network
relay blocks and transactions. The genesis and a bootnode are compiled into the binary,
so an empty data directory joins the network with no configuration.

## Signers and ordinary nodes

Every node runs the same binary. What differs is authorisation.

| | Ordinary node (you) | Signer |
|---|---|---|
| Downloads and re-executes every block | yes | yes |
| Serves JSON-RPC to your own apps | if you enable it | not exposed publicly |
| Relays transactions and blocks | yes | yes |
| Confirms (produces) blocks | **no** | yes, in rotation |
| Earns block rewards | no | 40 % of each block it confirms |
| How you become one | install and start it | a majority vote of the current signers |

The signer set is recorded on the chain. Read it with `clique_getSigners` on any node,
or in a console with `clique.getSigners()`. Signers are added or removed by a majority
vote of the current signers, and every vote is visible in block headers. The foundation
operates the signer set today. Blocks keep coming while more than half of the signers
are online.

Running a node does not make it a signer and earns nothing on its own. An
[open validator programme](https://ferminux.net/validators/) is being built: validator
nodes will check every block and sign checkpoints against a 2,000 FMX deposit per seat.
They will not produce blocks. The programme is not live yet; the page has a waitlist.

## The current release: A (`v1.1.0-posa`)

Release A is the binary that carries the authority fork at block 160,000. The network's
own nodes run it, and it is what the installer fetches.

| Platform | Archive | SHA-256 |
|---|---|---|
| Linux amd64 | `ferminux-geth-linux-amd64.tar.gz` | `516192942e38011a964e9b8b96a2b8defdfe51298365c22252e760861d610802` |
| Linux arm64 | `ferminux-geth-linux-arm64.tar.gz` | `c5ada49491d37354ea910009440085d36bf9997690e2d404014436657ae995c3` |
| macOS Apple Silicon | `ferminux-geth-macos-arm64.tar.gz` | `1ad3af8456f5f0d9c6713c773e37a98431f65f84e228b1a4904f925a8871f847` |

The archives are at `https://ferminux.net/downloads/`, listed in
[`SHA256SUMS.txt`](https://ferminux.net/downloads/SHA256SUMS.txt). That list is not
signed yet, so it proves a download is complete, not that the server is honest. The
table above is a cross-check from the same operator, not a signature.

**Windows:** no current build is published. The `ferminux-geth-windows-amd64.zip` still
on the download server is the pre-fork package: it stops following the chain at block
159,999. Do not use it. Run the Linux build under WSL2, or use Docker (below).

**Intel Macs:** no build is published. Build from source or use Docker.

## Install (Linux and Apple Silicon Macs)

```bash
curl -fsSL https://ferminux.net/install.sh | bash
```

The script picks the archive for your platform, checks its SHA-256 against the list,
installs the binary as `ferminux` in `/usr/local/bin` (or `~/.local/bin` without sudo),
and adds `ferminux-geth` as a second name for the same binary.

Start it:

```bash
ferminux --cache 512
```

That is a complete node. `--cache` sets the database cache in MB. Without it the client
assumes a large machine and reserves 4 GB, which gets small servers killed for running
out of memory; 256 to 1,024 is plenty for this chain.

The chain is small (a synced data directory is a few hundred MB), so a fresh node
catches up in minutes. Check progress against the
[explorer](https://explorer.ferminux.net):

```bash
ferminux attach --exec 'eth.blockNumber'
ferminux attach --exec 'eth.syncing'          # false once it has caught up
```

## What a healthy start looks like

Release A prints a banner that includes these lines:

```
INFO Writing default Ferminux genesis block
INFO Chain ID:  3961 (ferminux)
INFO  - Ferminux PoSA (Clique authority from this block): 160000
INFO Ferminux proof-of-authority engine armed  posaBlock=160,000 period=7 epoch=30000 signers=5 ...
WARN Ferminux PoSA checkpoint hash is unset: block PosaBlock-1 is not pinned
```

- The WARN line is expected on release A. The next release pins that block's hash.
- `signers=5` is the set compiled in for the fork block. The set has changed by vote
  since then; the live list is `clique.getSigners()`.
- Some banner lines are inherited from the upstream client and name another network or
  the pre-fork engine. [Troubleshooting](troubleshooting.md#the-start-up-banner-names-another-network)
  explains them.

## Where your data lives

| System | Default data directory |
|---|---|
| Linux (and WSL2) | `~/.ferminux` |
| macOS | `~/Library/Ferminux` |

Inside it:

| Path | Contents |
|---|---|
| `ferminux-geth/chaindata` | the chain database. The folder is named `ferminux-geth` whatever the binary is called |
| `keystore` | encrypted account keys, if you create any. Back this up |
| `geth.ipc` | the local console socket (`ferminux attach` finds it) |

Pass `--datadir /path` to put everything somewhere else. Flags always go before
positional arguments: `ferminux attach --exec 'eth.blockNumber' /path/geth.ipc`.

## Run it as a service (systemd)

```bash
sudo useradd --system --home /var/lib/ferminux --shell /usr/sbin/nologin ferminux
sudo mkdir -p /var/lib/ferminux && sudo chown ferminux:ferminux /var/lib/ferminux

sudo tee /etc/systemd/system/ferminux.service >/dev/null <<'UNIT'
[Unit]
Description=Ferminux node (chain 3961)
After=network-online.target
Wants=network-online.target

[Service]
User=ferminux
ExecStart=/usr/local/bin/ferminux --datadir /var/lib/ferminux --cache 512 \
  --http --http.addr 127.0.0.1 --http.port 8545 --http.api eth,net,web3,txpool
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now ferminux
journalctl -fu ferminux
```

Open `30303/tcp` and `30303/udp` in your firewall if you want other nodes to reach
yours. A node with only outbound connections still syncs.

## Docker

The source tree's `chain/` directory builds an image whose entry point is `ferminux`:

```bash
cd chain
docker build -t ferminux:local .

docker run -d --name ferminux --restart unless-stopped \
  -v ferminux-data:/root/.ferminux \
  -p 30303:30303 -p 30303:30303/udp \
  -p 127.0.0.1:8545:8545 \
  ferminux:local --cache 512 --http --http.addr 0.0.0.0 --http.api eth,net,web3
```

Inside the container `--http.addr 0.0.0.0` is needed for the port mapping to work; the
`127.0.0.1:8545` mapping keeps it reachable from this machine only.

## Build from source

```bash
cd chain
GOTOOLCHAIN=go1.20.14 make ferminux     # -> build/bin/ferminux (+ ferminux-geth, geth)
```

The client is on the go-ethereum v1.10.26 line and needs Go 1.18 to 1.20; the
`GOTOOLCHAIN` setting fetches Go 1.20.14 when your installed Go is newer. The source
builds the same consensus rules as release A.

## JSON-RPC, and how not to get drained

Local HTTP and WebSocket endpoints:

```bash
ferminux --http --http.addr 127.0.0.1 --http.port 8545 --http.api eth,net,web3,txpool
ferminux --ws   --ws.addr 127.0.0.1   --ws.port 8546   --ws.api eth,net,web3
```

Check it answers (expect `"result":"0xf79"`):

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
  http://127.0.0.1:8545
```

Rules worth keeping:

- **Keep `--http.addr 127.0.0.1`.** To serve other machines, put a reverse proxy with
  TLS and rate limits in front, as the public endpoint does.
- **Only `eth`, `net`, `web3` and `txpool` belong on an HTTP or WebSocket endpoint.**
  Never add `personal`, `admin`, `debug` or any other namespace. Sign transactions in a
  wallet or library, not on the node.
- `--http.corsdomain '*'` and `--http.vhosts '*'` are for local development only.
- Do not pass network presets such as `--mainnet` or `--sepolia`, or any `--override.*`
  flag. They still parse, and they do not do anything useful on this client.

## Confirm you are on the right chain

```bash
ferminux attach --exec 'eth.chainId()'          # 3961
ferminux attach --exec 'eth.getBlock(0).hash'   # 0x1b62e052…92fadf
ferminux attach --exec 'clique.getSigners()'    # today's authorised set
```

Then compare `eth.blockNumber` with the explorer. If your node sits at 159,999, read
[this](troubleshooting.md#my-node-stopped-at-block-159999).
