# fmx-validator

The Ferminux validator sidecar (Step 1: checkpoint validator nodes). It runs next to a
`ferminux` node on a Windows PC or a Linux server. Every 200 blocks (a checkpoint, about
every 23 minutes) it waits until the block is 64 deep on its own node, signs "at height h
I see block hash H" with the seat's attester key, and submits that attestation to the
`ValidatorHub` contract (`agents/contracts/src/validators/`).

Blocks are confirmed by the foundation signers under proof-of-authority consensus. A
validator node checks every block and signs checkpoints; it does not produce or order
blocks, and nothing here changes consensus.

## Quick start

The release packages do all of this with the commands below: `sudo ./install.sh`
on Linux, `install.ps1` from an administrator PowerShell on Windows (see
`packaging/README-*.txt`). Both register one service that runs the sidecar, and the
sidecar runs the node.

Linux, by hand (what `packaging/linux/install.sh` does):

```bash
D=/var/lib/fmx-validator                  # the default data directory for root
P=/etc/fmx-validator/attester-password    # root:root 0600; systemd hands it to the service
sudo useradd --system --home-dir $D --no-create-home --shell /usr/sbin/nologin fmx-validator
sudo install -d -m 0700 -o fmx-validator -g fmx-validator $D
sudo install -d -m 0700 /etc/fmx-validator
sudo install -m 0600 -o root -g root /dev/stdin $P   # type a password, then Ctrl-D
sudo fmx-validator keys new --password-file $P
sudo fmx-validator install --node-path /usr/local/lib/fmx-validator/ferminux --password-file $P --start
sudo fmx-validator status
sudo fmx-validator seat-proof --password-file $P --owner 0xYourOwnerWallet
```

`install` hands the network directory to the service user and writes a hardened
unit that receives the password with `LoadCredential=` (systemd 247 and later; on
older systemd it keeps a 0600 copy in the service user's own network directory). To
attach to a node that already runs instead, give `--node-ipc <its IPC path>` in place
of `--node-path`; the node must then run as the same user, and on Linux the sidecar
reads its command line from `/proc` to check the reorg cap.

Windows, from an administrator prompt (what `packaging/windows/install.ps1` does, with
the programs in `%ProgramFiles%\Ferminux`, a folder only SYSTEM and Administrators can
change, because the service runs them as LocalSystem):

```powershell
$fv = "$env:ProgramFiles\Ferminux\fmx-validator.exe"
& $fv install --node-path "$env:ProgramFiles\Ferminux\ferminux.exe"
& $fv keys new --store-password
Start-Service FerminuxValidator
& $fv status
& $fv seat-proof --owner 0xYourOwnerWallet
```

`install` makes the data directory (default `%ProgramData%\FerminuxValidator`) writable by
SYSTEM and Administrators only, because the service runs as LocalSystem and trusts what is
in it, and refuses if something inside was created by another account. Run the `keys`,
`protection` and `resume` commands from an administrator prompt too.

The owner wallet opens the seat with exactly 2,000 FMX; its key never touches this machine.
The attester key only signs attestations and needs about 1 FMX for transaction fees. A
seat activates about 24 h after the deposit and counts toward certification after 7 days.

## Commands

| Command | What it does |
|---|---|
| `init` | Writes `<data-dir>/<network>/config.json`. `--node-path` supervises a node binary; `--node-ipc` attaches to a running node (IPC path, or `http://127.0.0.1:port`); `--hub` sets the hub address. |
| `keys new` / `keys import` / `keys show` | One attester key per network, stored as scrypt keystore JSON. `--store-password` (Windows) keeps the password DPAPI-protected for the service. |
| `keys store-password` | Windows: DPAPI-protect (machine scope, file readable by SYSTEM and Administrators only) the keystore password so the service starts unattended. |
| `seat-proof --owner 0x…` | Prints the `openSeat` possession proofs and ready-made calldata for the owner wallet. |
| `run` | Runs until stopped. Also the service entry point. |
| `status [--json]` | What a running sidecar is doing, or what is on disk if it is not running. |
| `install` / `uninstall` | Registers the Windows service `FerminuxValidator` (Automatic, delayed start, restarted on failure, its own event log source), or writes a hardened systemd unit (`fmx-validator.service`). `--start` waits until the service is running and otherwise says why it is not. `--allow-inbound` lets the node map its P2P port on the router. Data is never deleted. |
| `protection export` / `import` / `show` | Moves the slashing-protection database with a key between machines. |
| `resume --yes` | Clears a safety stop after its cause has been dealt with. |

Every command takes `--data-dir` and `--network` (`mainnet` or `devnet`); `--chain-id 3961`
also selects mainnet. The installer scripts in `packaging/` call `keys new`, `install
--network mainnet --node-path … --data-dir … [--password-file …] [--allow-inbound]` and
`uninstall`; the service itself runs `run --data-dir … --network …`.

Not built yet (documented TODOs): submitting attestations through a free relay instead
of from the attester key (the key pays about 0.004 FMX a day in fees today), and peering
with the enodes registered on the hub (see Peering).

## Peering (sentry mode)

A supervised node needs no inbound port, so a home PC behind a router works
as it is. By default it starts with:

- discovery on, seeded from the bootnodes compiled into the node (so it finds
  peers by itself; `--nodiscover` would leave a home node with only the
  handful of peers listed by hand);
- `static-nodes.json` (in `node/ferminux-geth/`) listing the known public
  nodes, which the node keeps dialling for as long as it runs. The sidecar
  adds any missing ones at every start and keeps entries an operator added;
- `--maxpeers 25` (`node.maxPeers`), modest for a home connection and above
  the 3 peers mainnet needs before signing;
- `--nat none`, so the node never asks the router to open a port.
  `node.inbound: true` (`install --allow-inbound`) drops it and lets the node
  map its port with UPnP or NAT-PMP, for operators who also opened TCP/UDP
  30303 in their firewall.

A `--maxpeers` or `--nat` in `node.extraArgs` replaces the default.

Not built yet: peering with the enodes registered on the hub (plan 3.5
item 3: read the seats' enode keys and `admin_addPeer` them), which would
spread the load off the public nodes as seats grow.

## When it does not start

- **Windows.** The service hands itself to the service manager first and reports
  START_PENDING until its settings are read, its lock is held and its dashboard is up, so a
  slow start never ends in error 1053; anything that fails before that fails the start
  itself. Every error goes to Event Viewer (Windows Logs > Application, source
  `FerminuxValidator`) and the service stops with service-specific exit code 1, which
  triggers the restart actions.
- **Linux.** `journalctl -u fmx-validator` has the output.
- **Both.** The reason is also written to `<data-dir>/<network>/last-error.txt`, which
  `fmx-validator status` prints while the sidecar is not running; the next good start
  removes it. When the supervised node exits, the dashboard shows the node's own
  `Fatal:` line (a port already in use, a bad datadir), not just its exit status.

## What stops it from signing

Before every signature:

- **Readiness.** The node is on the configured chain, not syncing, its head is at most 60 s
  old, it has at least 3 peers, and its 64-block reorg cap is in force (not started with
  `--ferminux.allowdeepreorg`: known exactly for a supervised node, read from `/proc` on
  Linux, otherwise confirmed by the operator with `externalNodeFlagsChecked`).
- **Depth and window.** Checkpoint `h` is signed only when the node's head is at least
  `h+64`, and only while a transaction can still land in `[h+64, h+250]`.
- **On-chain self-check.** If the hub already holds an attestation by this seat for `h`
  that this machine did not sign, signing stops for good (`HALTED`).
- **Slashing-protection database** (`protection.log`). The exact `(chain, hub, attester,
  height, hash)` is appended and fsynced before the signature exists. A different hash for
  a recorded height is refused and stops signing. The file is append-only with a checksum
  per line; a torn last line from a crash is cut back and a watermark is raised to the
  current head; damage anywhere else refuses to start.
- **One process per key.** An OS file lock refuses a second sidecar on the same data
  directory. At start, the seat's latest on-chain attestation must be in this machine's
  database (unless the key became the attester through a rotation after that checkpoint),
  otherwise it refuses to run: another machine is using the key. Imported or adopted keys
  watch two clean checkpoints before signing.
- **Signing domain.** At start the hub's `domainSeparator()` and `attestationDigest()`
  must equal this build's; otherwise nothing is signed.

The signed message is a typed structured-data signature over
`Attestation(uint64 height, bytes32 blockHash)` in the domain
`{"Ferminux Validator Hub", "1", chainId, hub}`; signatures are 65 bytes with `v` 27/28
and low `s`.

## Files

```
<data-dir>/<network>/
  config.json             settings
  keys/attester.json      attester keystore (scrypt); keys/ is 0700, or SYSTEM+Administrators on Windows
  keys/attester.network   the network the key belongs to
  keys/attester.pass.dpapi  Windows: DPAPI-protected keystore password
  protection.log          slashing-protection database (append-only)
  HALTED                  present while a safety stop is in force
  last-error.txt          why the last run failed (removed by the next good start)
  dashboard.addr          the dashboard's 127.0.0.1 address
  node/                   the supervised node's datadir
  logs/                   fmx-validator.log, node.log (rotated)
```

The dashboard (and `fmx-validator status`) leads with one state worked out by the sidecar:
stopped for safety, node not running, setup needed, syncing (block n of m), not ready,
attestations paused at the hub, no seat yet, waiting to activate, paused for low
participation (until block n), unbonding (until block n), seat closed, checking the key,
or attesting, each with what to do next. While the sidecar cannot attest yet (no hub
address, no key) it still shows the node's sync progress.

The dashboard binds a loopback address only (random port unless `dashboard` is set),
answers only `GET` requests addressed to that loopback host, and sends no CORS headers.
Nothing logs key material or passwords.

## Building and testing

Pure Go, `CGO_ENABLED=0`, Go 1.20.14 like `chain/` (the module links the node's own
packages through `replace … => ../chain`).

```bash
make build            # bin/fmx-validator
make cross            # windows/amd64, linux/amd64, linux/arm64
make test             # unit tests
make test-integration # the built binary against the real ValidatorHub on a local anvil
                      # chain (chain id 3961, 127.0.0.1 only); needs anvil and forge
```

`testdata/attestation_vectors.json` is the signing cross-test shared with the contracts:
the Go tests generate and pin it (`make vectors` after a deliberate format change), and
`testdata/hubtest` (`forge test`) checks the same file against the real `ValidatorHub`
compiled from `agents/contracts/src/validators`: separator, digests, signature rules, and
an `openSeat` plus `attest` round trip with the sidecar's proofs.

`internal/hub/abi.json` is generated from the real hub by `make abi`. Seats are read
through the hub's `extsload` with the storage layout `ValidatorHubLens` uses (seats at
slot 33); the hub is not upgradeable, so that layout is fixed.
