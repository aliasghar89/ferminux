FERMINUX VALIDATOR - WINDOWS
============================

What this is
------------
This installs a Ferminux checkpoint validator node on a Windows 10 or 11
PC. It is Step 1 of the validator plan: your PC keeps its own full copy of
the Ferminux chain (chain ID 3961), checks every block, and about every 23
minutes signs a short statement naming the block it sees at that
checkpoint height. When enough validators sign the same block, the
explorer marks it "certified": public proof that nobody rewrote history.

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
  C:\Program Files\Ferminux\fmx-validator.exe   the sidecar: runs the node,
                                                signs checkpoint attestations,
                                                keeps the slashing-protection
                                                database
  C:\Program Files\Ferminux\ferminux.exe        the chain 3961 node
  C:\ProgramData\FerminuxValidator\             settings, the attester key,
                                                the slashing-protection
                                                database, chain data and logs

One Windows service, "Ferminux Validator" (FerminuxValidator), runs the
sidecar, which starts the node. It starts automatically (delayed start)
after a reboot, with nobody logged in, and restarts itself after a failure.

Only SYSTEM and Administrators can change either folder: the service runs
these programs with full rights, so no other account may replace them.

The attester key is a hot key that can only sign attestations. Its
password is kept for the service with Windows DPAPI (machine scope). It
needs about 1 FMX for transaction fees and never holds your deposit.

Requirements
------------
  - Windows 10 or 11, 64-bit
  - 2 CPU cores, 2 GB free RAM, 5 GB free disk space
  - A connection that is up most of the time (you earn less, never lose
    your deposit, when your PC is asleep or off)

Installing
----------
1. Extract this zip to its own folder. Keep install.ps1, uninstall.ps1,
   ferminux.exe, fmx-validator.exe and this file together.
2. Right-click "Windows PowerShell" (or "Terminal") and choose "Run as
   administrator". This is required: the installer writes to Program
   Files and ProgramData and registers a Windows service.
3. In that window, go to the extracted folder and run:

       powershell -ExecutionPolicy Bypass -File .\install.ps1

4. When asked, choose a password for the attester key (12 characters or
   more) and type it twice. Keep your own copy of it.
5. The installer starts the service and prints its status and the
   attester key's address.
6. Back up C:\ProgramData\FerminuxValidator\mainnet\keys\attester.json
   and its password somewhere other than this PC.
7. Send about 1 FMX to the attester address for transaction fees.
8. Once the ValidatorHub address is published, print what your wallet
   needs to open the seat, and send it from your own wallet:

       & 'C:\Program Files\Ferminux\fmx-validator.exe' seat-proof --owner <your wallet address>

   The seat activates about 24 hours after the deposit and counts toward
   certification after 7 days.

Installer options:
       -NoKey             do not create a key (to import one instead)
       -NoStart           register the service but do not start it
       -AllowInboundP2P   accept inbound peers (see below)
       -InstallDir, -DataDir   other folders than the ones above

Networking and your firewall
----------------------------
By default the node finds peers through the bootnodes built into it and
keeps a standing link to the known public nodes, all outbound (sometimes
called "sentry mode"). No inbound port needs to be open for your validator
to attest or earn rewards, and the installer does not open one.

If you also want to accept inbound peers, run the installer with:

       powershell -ExecutionPolicy Bypass -File .\install.ps1 -AllowInboundP2P

The node may then map port 30303 on your router (UPnP), and a firewall
rule lets TCP/UDP 30303 reach ferminux.exe. Running the installer again
without the switch removes the rule.

Checking on it
--------------
From an administrator prompt:

       & 'C:\Program Files\Ferminux\fmx-validator.exe' status

It leads with one line (setup needed, syncing, waiting to activate,
attesting, paused, and so on) with what to do next, and prints the address
of the local dashboard, a page only this PC can open.

If the service does not start, `status` shows why its last run failed, and
Event Viewer has every service error under Windows Logs > Application,
source FerminuxValidator. Logs are in
C:\ProgramData\FerminuxValidator\mainnet\logs.

Uninstalling
------------
From an elevated PowerShell prompt, in the same folder:

       powershell -ExecutionPolicy Bypass -File .\uninstall.ps1

This stops and removes the service and deletes the two programs. It keeps
C:\ProgramData\FerminuxValidator, because it holds the attester key and its
slashing-protection history, which belong together. To delete that too:

       powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -RemoveData

Uninstalling never touches your seat or its deposit on chain. To get the
2,000 FMX back, request an exit from the owner wallet; it can be withdrawn
after the 14-day unbonding period.

Downtime and penalties, in plain terms
--------------------------------------
  - Your PC being asleep, restarting for Windows Update or offline for a
    while costs only the rewards you missed. It never costs any of your
    deposit.
  - The only thing that costs part of your deposit is signing two different
    statements for the same checkpoint with the same key. Run one copy of
    your key at a time: the slashing-protection database and the
    one-process lock in this software are there to stop exactly that.

Rewards are paid in FMX per checkpoint, shown as FMX per day, never as a
yearly percent and never in dollars.

Getting help
------------
See https://ferminux.net/docs for the current documentation.
