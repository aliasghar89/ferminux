FERMINUX VALIDATOR - LINUX
==========================

What this is
------------
This installs a Ferminux checkpoint validator node on a Linux server. It is
Step 1 of the validator plan: the server keeps its own full copy of the
Ferminux chain (chain ID 3961), checks every block, and about every 23
minutes signs a short statement naming the block it sees at that checkpoint
height. When enough validators sign the same block, the explorer marks it
"certified": public proof that nobody rewrote history.

Ferminux uses proof-of-authority consensus. Blocks are confirmed every 7
seconds by a set of authorised signers run by the Ferminux foundation, and
that does not change here. A validator node in Step 1:
  - does NOT produce or order blocks
  - does NOT make the chain proof of stake
  - CANNOT stop or overrule the signers

The installer moves no FMX and needs no wallet key. The seat is opened
later from your own wallet, with exactly 2,000 FMX.

What gets installed
-------------------
  /usr/local/bin/fmx-validator            the sidecar: runs the node, signs
                                          checkpoint attestations, keeps the
                                          slashing-protection database
  /usr/local/lib/fmx-validator/ferminux   the chain 3961 node the sidecar runs
  /etc/systemd/system/fmx-validator.service
                                          one hardened systemd unit, running
                                          as the unprivileged fmx-validator user
  /var/lib/fmx-validator/mainnet/         settings, the attester key, the
                                          slashing-protection database, the
                                          chain data and the logs (owned by
                                          fmx-validator, mode 0700)
  /etc/fmx-validator/attester-password    a random password for the attester
                                          key (root only, mode 0600); systemd
                                          hands it to the service

The attester key is a hot key that can only sign attestations. It needs
about 1 FMX for transaction fees and never holds your deposit.

Requirements
------------
  - 64-bit Linux (amd64) with systemd 247 or later (Debian 11+, Ubuntu
    22.04+, RHEL 9+). On older systemd the installer still works: it keeps
    a copy of the password in the service's own data directory instead.
  - 2 CPU cores, 2 GB free RAM, 5 GB free disk space
  - A connection that is up most of the time (you earn less, never lose
    your deposit, when the server is offline)

Installing
----------
1. Extract the release and go into it:

       tar xzf ferminux-validator-linux-amd64.tar.gz
       cd ferminux-validator-linux-amd64   # or wherever you extracted it

2. Run the installer as root:

       sudo ./install.sh

   It creates the attester key, registers the service and starts it,
   then prints the key's address and the service's status.

   Options:
       --no-key          do not create a key (to import one instead)
       --no-start        register the service but do not start it
       --allow-inbound   let the node map its P2P port on your router

3. Back up /var/lib/fmx-validator/mainnet/keys/attester.json and
   /etc/fmx-validator/attester-password somewhere other than this server.
4. Send about 1 FMX to the attester address for transaction fees.
5. Once the ValidatorHub address is published, print what your wallet
   needs to open the seat, and send it from your own wallet:

       sudo fmx-validator seat-proof --password-file /etc/fmx-validator/attester-password --owner <your wallet address>

   The seat activates about 24 hours after the deposit and counts toward
   certification after 7 days.

Networking and your firewall
----------------------------
The node finds peers through the bootnodes built into it and keeps a
standing link to the known public nodes, all outbound. No inbound port has
to be opened for a validator to attest or earn rewards, so the installer
does not touch your firewall. With --allow-inbound the node may also map
TCP/UDP 30303 on your router; open that port yourself if you want inbound
peers.

Checking on it
--------------
    sudo fmx-validator status        what it is doing, and the dashboard address
    journalctl -u fmx-validator -f   the service's output
    sudo tail -f /var/lib/fmx-validator/mainnet/logs/node.log

`status` leads with one line: setup needed, syncing, waiting to activate,
attesting, paused, and so on, with what to do next. If the service stopped,
it also shows why its last run failed.

Uninstalling
------------
    sudo ./uninstall.sh                # keeps the data and the password
    sudo ./uninstall.sh --remove-data  # also deletes them, and the user

Uninstalling keeps /var/lib/fmx-validator and /etc/fmx-validator unless you
pass --remove-data: they hold the attester key, its password and its
slashing-protection history, which belong together.

Uninstalling never touches your seat or its deposit on chain. To get the
2,000 FMX back, request an exit from the owner wallet; it can be withdrawn
after the 14-day unbonding period.

Downtime and penalties, in plain terms
--------------------------------------
  - The server being offline costs only the rewards you missed. It never
    costs any of your deposit.
  - The only thing that costs part of your deposit is signing two different
    statements for the same checkpoint with the same key. Run one copy of
    your key at a time: the slashing-protection database and the
    one-process lock in this software are there to stop exactly that.

Rewards are paid in FMX per checkpoint, shown as FMX per day, never as a
yearly percent and never in dollars.

Getting help
------------
See https://ferminux.net/docs for the current documentation.
