<#
.SYNOPSIS
    CI smoke test for the Windows packaging, on a real Windows runner.

.DESCRIPTION
    Runs the staged release's install.ps1, checks what it set up (the service
    registration, the program folder's permissions), starts the service
    against a devnet configuration that talks to no network at all, checks the
    DPAPI-stored password reaches the service, breaks the configuration to
    check that a failed start is reported with its reason (Start-Service
    fails, `status` and the event log say why; never a 1053 timeout), and
    uninstalls everything.

    Nothing here joins chain 3961 or any public network: the mainnet install
    is registered with -NoStart, and the service that does run is a devnet
    sidecar attached to a node address where nothing listens.

.PARAMETER Release
    The staged release folder (install.ps1, uninstall.ps1 and both programs).
#>
[CmdletBinding()]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute(
    'PSAvoidUsingWriteHost', '',
    Justification = 'CI log output.')]
param(
    [Parameter(Mandatory = $true)][string]$Release
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ServiceName = 'FerminuxValidator'
$InstallDir = Join-Path $env:ProgramFiles 'Ferminux'
$DataDir = Join-Path $env:ProgramData 'FerminuxValidator'
$Exe = Join-Path $InstallDir 'fmx-validator.exe'
$DevChain = '31337'
# any address: the devnet sidecar only needs one configured to go on to open its key
$DevHub = '0x5FbDB2315678afecb367f032d93F642f64180aa3'

function Exit-Smoke {
    param([string]$Message)
    Write-Host "FAIL: $Message" -ForegroundColor Red
    foreach ($log in (Get-ChildItem -Path (Join-Path $DataDir '*\logs\fmx-validator.log') -ErrorAction SilentlyContinue)) {
        Write-Host "--- $($log.FullName)"
        Get-Content -LiteralPath $log.FullName -Tail 30
    }
    exit 1
}

function Invoke-Checked {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { Exit-Smoke "fmx-validator.exe $($Arguments -join ' ') exited with $LASTEXITCODE" }
}

$Release = (Resolve-Path -LiteralPath $Release).Path

Write-Host '==> install.ps1 -NoKey -NoStart'
& (Join-Path $Release 'install.ps1') -NoKey -NoStart
$svc = Get-CimInstance -ClassName Win32_Service -Filter "Name='$ServiceName'"
if (-not $svc) { Exit-Smoke 'service not registered' }
if ($svc.StartMode -ne 'Auto' -or -not $svc.DelayedAutoStart) { Exit-Smoke "start mode $($svc.StartMode), delayed $($svc.DelayedAutoStart)" }
if ($svc.PathName -notlike "*$InstallDir\fmx-validator.exe*run --data-dir*--network mainnet*") { Exit-Smoke "service command line: $($svc.PathName)" }
if ($svc.State -ne 'Stopped') { Exit-Smoke '-NoStart started the service' }

# only SYSTEM and Administrators may write where the service's programs live
$acl = Get-Acl -LiteralPath $InstallDir
if (-not $acl.AreAccessRulesProtected) { Exit-Smoke 'the program folder still inherits permissions' }
$writeRights = [Security.AccessControl.FileSystemRights]'Write, Modify, FullControl, CreateFiles, AppendData, WriteData, ChangePermissions, TakeOwnership'
foreach ($rule in $acl.Access) {
    $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($sid -in @('S-1-5-18', 'S-1-5-32-544')) { continue }
    if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $writeRights)) {
        Exit-Smoke "$($rule.IdentityReference) may write to $InstallDir ($($rule.FileSystemRights))"
    }
}
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544') { Exit-Smoke "program folder owner is $($acl.Owner)" }
$config = Get-Content -Raw -LiteralPath (Join-Path $DataDir 'mainnet\config.json') | ConvertFrom-Json
if ($config.node.binary -ne (Join-Path $InstallDir 'ferminux.exe') -or -not $config.node.supervise) { Exit-Smoke "config does not supervise the installed node: $($config.node | ConvertTo-Json -Compress)" }
Write-Host 'OK: mainnet install registered, not started, program folder locked'

Write-Host '==> devnet service: start, status, password from DPAPI'
$pw = Join-Path $env:RUNNER_TEMP 'fmx-smoke-password.txt'
Set-Content -LiteralPath $pw -Value 'a smoke-test password, devnet only' -NoNewline
Invoke-Checked @('keys', 'new', '--network', 'devnet', '--chain-id', $DevChain, '--password-file', $pw, '--store-password')
Remove-Item -LiteralPath $pw -Force
Invoke-Checked @('init', '--network', 'devnet', '--chain-id', $DevChain, '--hub', $DevHub, '--node-ipc', 'http://127.0.0.1:9')
Invoke-Checked @('install', '--network', 'devnet', '--chain-id', $DevChain, '--node-ipc', 'http://127.0.0.1:9', '--start')
if ((Get-Service -Name $ServiceName).Status -ne 'Running') { Exit-Smoke 'devnet service is not running' }
Start-Sleep -Seconds 3
$out = (& $Exe status --network devnet) -join "`n"
Write-Host $out
if ($out -notmatch 'state ') { Exit-Smoke 'status has no state line' }
$log = Join-Path $DataDir 'devnet\logs\fmx-validator.log'
if (-not (Select-String -LiteralPath $log -Pattern 'attester key opened .*windows dpapi' -Quiet)) { Exit-Smoke 'the key was not opened with the DPAPI-stored password' }
Write-Host 'OK: devnet service running, password delivered by DPAPI'

Write-Host '==> a broken config.json: the start fails and says why'
Stop-Service -Name $ServiceName
$devConfig = Join-Path $DataDir 'devnet\config.json'
$good = Get-Content -Raw -LiteralPath $devConfig
Set-Content -LiteralPath $devConfig -Value "{`"network`":`"devnet`",`"chainId`":$DevChain,`"surprise`":true}"
$failed = $false
try { Start-Service -Name $ServiceName -ErrorAction Stop } catch { $failed = $true; Write-Host "Start-Service: $($_.Exception.Message)" }
if (-not $failed) { Exit-Smoke 'a service with a broken config.json started' }
$svc = Get-CimInstance -ClassName Win32_Service -Filter "Name='$ServiceName'"
if ($svc.ExitCode -eq 1053) { Exit-Smoke 'the service manager reports 1053' }
$out = (& $Exe status --network devnet) -join "`n"
Write-Host $out
if ($out -notmatch 'last run  failed:.*surprise') { Exit-Smoke 'status does not say why the start failed' }
$events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = $ServiceName } -MaxEvents 5 -ErrorAction SilentlyContinue)
if (-not ($events | Where-Object { $_.Message -match 'surprise' })) { Exit-Smoke 'the event log does not say why the start failed' }
# the recovery actions restart it; stop that before restoring the settings
Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue
Set-Content -LiteralPath $devConfig -Value $good -NoNewline
# a restart the recovery actions had already queued now finds good settings; let it settle
Start-Sleep -Seconds 15
Write-Host 'OK: failed start reported by Start-Service, status and the event log'

Write-Host '==> uninstall.ps1 -RemoveData -Force'
& (Join-Path $Release 'uninstall.ps1') -RemoveData -Force
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) { Exit-Smoke 'service left behind' }
foreach ($p in @($Exe, (Join-Path $InstallDir 'ferminux.exe'), $DataDir)) {
    if (Test-Path -LiteralPath $p) { Exit-Smoke "$p left behind" }
}
Write-Host 'OK: uninstalled'
Write-Host '==> Windows packaging smoke test passed.'
