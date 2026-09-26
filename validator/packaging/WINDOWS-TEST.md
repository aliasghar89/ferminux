# Ferminux Validator on Windows: test script for a real PC

The validator devnet (`validator/devnet/`) proved the Step 1 checklist with Linux builds in
containers. Everything that only Windows can show has to be checked on a real Windows 10 or
Windows 11 PC. This page is that check, written so you can follow it on your own PC, one step
at a time, and note what you saw.

It takes about an hour, plus one reboot and one sleep. Nothing here moves FMX, needs a wallet
key or opens a seat: the ValidatorHub is not on mainnet yet, so the validator waits for its hub
address while its node follows chain 3961 as an ordinary read-only node.

Ferminux uses proof-of-authority consensus. A validator node checks blocks and signs checkpoint
statements; it does not produce blocks, and nothing on this page changes that.

## What must be tested on Windows, and why the devnet could not

| # | What | Why only a real PC shows it | Step |
|---|---|---|---|
| W1 | The Windows node `ferminux.exe` (built natively with cgo) starts, has the Ferminux genesis and follows chain 3961 past block 1,000 | The devnet ran Linux arm64 builds; the Windows binary is a different build | 3, 6 |
| W2 | `install.ps1` from an administrator PowerShell: programs in `C:\Program Files\Ferminux`, a Windows service, folders only SYSTEM and Administrators can change | Windows services, ACLs and PowerShell exist only on Windows | 2 |
| W3 | The attester key is created and its password kept with DPAPI (machine scope), so the service starts with nobody typing it | DPAPI is Windows-only | 2, 4 |
| W4 | The dashboard opens on this PC only (127.0.0.1) and `status` says what the validator is doing | Loopback binding and the browser on the PC | 5 |
| W5 | Stop and start the service; a second copy of the sidecar is refused | Service control manager, file lock on NTFS | 7, 8 |
| W6 | The service comes back after a reboot with nobody logged in (Automatic, delayed start) | Needs a real reboot | 9 |
| W7 | Sleep and resume: the node catches up and the validator is ready again | Needs a real sleep | 10 |
| W8 | A failed start says why (in `status`, in Event Viewer) and the service restarts itself after a crash | Event Viewer, service recovery actions | 11 |
| W9 | Installing again over an existing install keeps the key and replaces the programs | Upgrade path of the service | 12 |
| W10 | Uninstall removes the service and programs and keeps the key; `-RemoveData` removes the data too | Windows service removal | 13 |
| W11 | Microsoft Defender and SmartScreen: what they say about the (still unsigned) programs | Only Windows has them | 1, 14 |

Not on this page, because it needs a hub that exists: opening a seat, attesting and earning on
Windows. That is covered on the public testnet (plan step 1c) with the same package.

## Before you start

- A Windows 10 or 11 PC, 64-bit, with 2 CPU cores, 2 GB of free RAM, 5 GB of free disk and an
  internet connection. A spare PC or a virtual machine is best; nothing here harms a normal PC.
- An administrator account on it.
- The release zip `ferminux-validator-windows-amd64.zip`. It is built by the
  `validator-release` workflow on GitHub (Actions > validator-release > the latest run on
  `main` > Artifacts). Ask the developer for the link if you do not see it.
- Write down, for every step below: **pass** or **fail**, and for a fail, what you saw
  (a photo of the screen is fine).

Throughout, "admin PowerShell" means: Start menu, type `PowerShell`, right-click
**Windows PowerShell**, **Run as administrator**, answer **Yes**.

---

## Step 1. Unpack the zip (W11)

1. Download `ferminux-validator-windows-amd64.zip` to your Downloads folder.
2. Right-click it, **Properties**. If there is an **Unblock** box at the bottom, tick it, **OK**.
3. Right-click the zip, **Extract All...**, to `C:\Users\<you>\Downloads\ferminux-validator`.
4. Open that folder.

**Expected:** the folder holds `ferminux.exe`, `fmx-validator.exe`, `install.ps1`,
`uninstall.ps1` and `README-windows.txt`. Microsoft Defender does not delete or quarantine
either program. Write down any Defender message exactly as it appears.

## Step 2. Install (W2, W3)

1. Open an admin PowerShell.
2. Type (each line, then Enter):

   ```powershell
   cd $env:USERPROFILE\Downloads\ferminux-validator
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

3. When it asks for a password, type one of **12 characters or more**, press Enter, type it
   again, Enter. Write it down somewhere safe; you need it only if you move the key.

**Expected, in order on the screen:**

- `==> Installing the programs to C:\Program Files\Ferminux` and
  `Only SYSTEM and Administrators can change this folder (Users may read and run).`
- `==> Registering the Ferminux Validator service`, then
  `service "FerminuxValidator" (Ferminux Validator) registered: Automatic (Delayed Start), restarted on failure`.
- `==> Creating the attester key`, the two password prompts, then
  `attester key created for mainnet (chain 3961)`, an **address** starting `0x`, the key file
  `C:\ProgramData\FerminuxValidator\mainnet\keys\attester.json`, and
  `password stored for the service (DPAPI, machine scope): ...attester.pass.dpapi`.
- `==> Networking` and `Sentry mode: ... No inbound port is needed and none is opened.`
- `==> Starting the service`, then a status block (see step 5 for what it says).
- In green: `Ferminux Validator is installed: programs in C:\Program Files\Ferminux, data in C:\ProgramData\FerminuxValidator.`

Write down the attester address. **Fail** if any red error appears.

4. Check the folder permissions. In the same window:

   ```powershell
   icacls "C:\Program Files\Ferminux"
   icacls "C:\ProgramData\FerminuxValidator"
   ```

**Expected:** only `NT AUTHORITY\SYSTEM` and `BUILTIN\Administrators` have `(F)` (full
control); `BUILTIN\Users` has at most read `(RX)`; no line for your own user account with
`(F)`, `(M)` or `(W)`.

## Step 3. The node is the Ferminux node (W1)

In the admin PowerShell:

```powershell
& 'C:\Program Files\Ferminux\ferminux.exe' version
& 'C:\Program Files\Ferminux\fmx-validator.exe' version
```

**Expected:** the first prints `Ferminux Node`, `Architecture: amd64`, `Go Version: go1.20.14`.
The second prints `fmx-validator` and a version.

Then (after the service has run for a minute):

```powershell
& 'C:\Program Files\Ferminux\ferminux.exe' attach --exec "eth.getBlock(0).hash + ' chain ' + eth.chainId()" \\.\pipe\fmx-validator-mainnet.ipc
```

**Expected:** `0x1b62e052ee210c433440b9cd21b93b3e6cdc813fe63674c842bca3967d92fadf chain 0xf79`
(0xf79 is 3961). If it says it cannot connect, write down the message; step 6 checks the same
thing another way.

## Step 4. The key is locked down (W3)

```powershell
& 'C:\Program Files\Ferminux\fmx-validator.exe' keys show
```

**Expected:** `network mainnet (chain 3961)`, the same address as in step 2, `imported no`,
and `password  stored for the service (DPAPI)`.

Now open a **normal** (not administrator) PowerShell and try to read the key:

```powershell
Get-Content C:\ProgramData\FerminuxValidator\mainnet\keys\attester.json
```

**Expected:** `Access to the path ... is denied.` Close that normal window.

## Step 5. Status and the dashboard (W4)

In the admin PowerShell:

```powershell
& 'C:\Program Files\Ferminux\fmx-validator.exe' status
```

**Expected:** the first line is `fmx-validator <version>  mainnet (chain 3961)  dashboard http://127.0.0.1:<port>/`.
The `state` line is one of:

- `Syncing the chain` with `Block <n> of <m>` (in the first minutes), or
- `Setup needed`, with the reason
  `the ValidatorHub address is not configured yet (config.json "hub", set once the hub is published); nothing is signed until then`
  and `The node is at block <n> with <p> peer(s).`

Both are correct today. `process running=yes`.

Open the `http://127.0.0.1:<port>/` address from that first line in Edge or Chrome **on this
PC**. **Expected:** the Ferminux Validator dashboard opens and shows the same state and the
node's block height, which goes up by about one every 7 seconds when you refresh. It shows no
FMX-per-year figure and no dollar amounts. Take a screenshot.

From another device on your network (a phone on the same Wi-Fi), open
`http://<this PC's IP>:<port>/`. **Expected:** it does not open (the dashboard answers this PC
only).

## Step 6. The node follows chain 3961 past block 1,000 (W1)

Wait until `status` shows `The node is at block` with a number above 1,000 and at least 3
peers (a few minutes; the chain data is small). Compare the block number with
https://explorer.ferminux.net: it should be within a few blocks.

**Expected:** the node's block number keeps rising and matches the explorer. Write down the
number and the time it took from step 2.

## Step 7. Stop and start (W5)

```powershell
Stop-Service FerminuxValidator
Get-Service FerminuxValidator
& 'C:\Program Files\Ferminux\fmx-validator.exe' status
```

**Expected:** `Stop-Service` returns within about a minute (the sidecar stops the node
cleanly first). `Get-Service` shows `Stopped`. `status` says the sidecar is not running and
shows what is on disk (no error about a damaged database). Task Manager (Details tab) shows no
`ferminux.exe` and no `fmx-validator.exe`.

```powershell
Start-Service FerminuxValidator
Start-Sleep 30
& 'C:\Program Files\Ferminux\fmx-validator.exe' status
```

**Expected:** `Running`, and `status` is back to the state of step 5 with the block number
higher than before the stop. Task Manager shows both programs again.

## Step 8. A second copy is refused (W5)

With the service running:

```powershell
& 'C:\Program Files\Ferminux\fmx-validator.exe' run
```

**Expected:** it refuses at once with `another fmx-validator is already running for mainnet`
(the data directory's lock), and returns to the prompt. It must **not** start a second
node. The service keeps running (`Get-Service FerminuxValidator` is still `Running`).

## Step 9. Reboot with nobody logged in (W6)

1. Note the block number from `status`.
2. Restart the PC (Start > Power > Restart). At the sign-in screen, **do not sign in**. Wait 5
   minutes.
3. Sign in, open an admin PowerShell and run `status` again.

**Expected:** the service is `Running`, and the `process` line shows it started about 2 minutes
after boot (delayed start), before you signed in: the node's block number is well past the one
you noted, and `logs\fmx-validator.log` in `C:\ProgramData\FerminuxValidator\mainnet\` has
lines from before your sign-in time.

## Step 10. Sleep and resume (W7)

1. Put the PC to sleep (Start > Power > Sleep) for 10 minutes. Wake it.
2. Straight away, run `status`, then again 2 minutes later.

**Expected:** straight after waking it may say `Not signing: the node is not ready` (for
example the latest block is too old) or `Syncing the chain`; within a couple of minutes it is
back to the step 5 state with the block number caught up. The service never stopped.

## Step 11. A failed start explains itself, and a crash is restarted (W8)

1. Stop the service and rename the node program:

   ```powershell
   Stop-Service FerminuxValidator
   Rename-Item 'C:\Program Files\Ferminux\ferminux.exe' ferminux.exe.bak
   Start-Service FerminuxValidator
   Start-Sleep 20
   & 'C:\Program Files\Ferminux\fmx-validator.exe' status
   ```

   **Expected:** `status` names the problem in plain words (the node program cannot be
   started or is missing). Open **Event Viewer** > Windows Logs > Application: there are
   entries with source **FerminuxValidator** saying the same. No password or key appears in
   either.

2. Put it back:

   ```powershell
   Stop-Service FerminuxValidator -ErrorAction SilentlyContinue
   Rename-Item 'C:\Program Files\Ferminux\ferminux.exe.bak' ferminux.exe
   Start-Service FerminuxValidator
   ```

   **Expected:** `status` returns to the step 5 state.

3. Crash test: end the sidecar abruptly.

   ```powershell
   Stop-Process -Name fmx-validator -Force
   Start-Sleep 90
   Get-Service FerminuxValidator
   & 'C:\Program Files\Ferminux\fmx-validator.exe' status
   ```

   **Expected:** Windows restarts the service by itself (it is `Running` again), and `status`
   is back to the step 5 state. There is no message about a damaged slashing-protection
   database. Write down if a `ferminux.exe` was left running on its own after the crash
   (Task Manager, Details) and whether the restarted service still came up.

## Step 12. Install again over the existing install (W9)

In the admin PowerShell, in the extracted folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

**Expected:** `Stopping the running FerminuxValidator service before upgrading`, the programs
are copied again, and `An attester key already exists; keeping it` with the **same** address
as step 2 (no password is asked). The service starts again and `status` is back to the step 5
state.

Optional: run it once more with `-AllowInboundP2P`, check **Windows Defender Firewall with
Advanced Security** > Inbound Rules shows `Ferminux Validator (P2P inbound)` (TCP and UDP
30303, program `ferminux.exe`), then run `install.ps1` again without the switch and check both
rules are gone.

## Step 13. Uninstall (W10)

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

**Expected:** the service stops and is removed (`Get-Service FerminuxValidator` then says it
cannot find the service), `C:\Program Files\Ferminux\ferminux.exe` and `fmx-validator.exe` are
gone, and the message says the data folder was kept. `C:\ProgramData\FerminuxValidator\mainnet\keys\attester.json`
still exists.

Then remove the data too:

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -RemoveData
```

**Expected:** it asks before deleting, and after you confirm,
`C:\ProgramData\FerminuxValidator` is gone. Event Viewer no longer lists FerminuxValidator as a
source for new events.

## Step 14. Microsoft Defender scan (W11)

Before you delete the extracted folder: right-click it, **Scan with Microsoft Defender**.

**Expected:** no threats found. The programs are not code-signed yet, so a SmartScreen or
"unknown publisher" warning is possible when a program is started by hand; write down its
exact wording. That warning goes away only with a code-signing certificate (plan section 7).

---

## Results to send back

| Step | What | Windows 10 | Windows 11 |
|---|---|---|---|
| 1 | Unpack; Defender quiet | | |
| 2 | Install; folder permissions | | |
| 3 | Genesis hash and chain id | | |
| 4 | Key locked down; DPAPI password | | |
| 5 | `status` and dashboard (this PC only) | | |
| 6 | Past block 1,000, matches the explorer (time taken) | | |
| 7 | Stop and start | | |
| 8 | Second copy refused | | |
| 9 | Reboot, nobody logged in | | |
| 10 | Sleep and resume | | |
| 11 | Failed start explained; crash restarted | | |
| 12 | Install over existing, same key; firewall rule on/off | | |
| 13 | Uninstall keeps data; `-RemoveData` removes it | | |
| 14 | Defender scan; any SmartScreen wording | | |

Also send: Windows edition and version (Settings > System > About), and the zip's name and
date.

A plan gate stays in force whatever these results are: no Windows download is published until
this exact binary has passed on real Windows 10 and Windows 11, and until it is code-signed.
