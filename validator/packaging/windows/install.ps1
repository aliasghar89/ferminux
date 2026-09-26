<#
.SYNOPSIS
    Installs the Ferminux Validator (node and sidecar) as a Windows service.

.DESCRIPTION
    Step 1 of the validator plan (checkpoint validator nodes). ferminux.exe
    (the chain 3961 node) and fmx-validator.exe (the sidecar that runs the
    node, signs checkpoint attestations and keeps the slashing-protection
    database) are copied to -InstallDir, a folder only SYSTEM and
    Administrators can change, and fmx-validator.exe registers itself as the
    FerminuxValidator service, which starts the node.

    The steps are the sidecar's own commands:
        fmx-validator.exe install --data-dir <DataDir> --network mainnet --node-path <InstallDir>\ferminux.exe
        fmx-validator.exe keys new --data-dir <DataDir> --store-password   (unless a key exists, or -NoKey)
        Start-Service FerminuxValidator                                    (unless -NoStart)

    The attester key is a hot key that can only sign attestations. It is
    created here, with a password you choose, which is kept for the service
    with machine-scope DPAPI. No FMX is moved and no wallet key is created or
    needed: the seat is opened later from your own wallet.

    A validator node checks blocks and signs checkpoint attestations. It does
    not produce blocks, and nothing here changes chain consensus.

.PARAMETER InstallDir
    Where the two programs go. Defaults to %ProgramFiles%\Ferminux. Its
    permissions are set to full control for SYSTEM and Administrators and
    read for Users, because the service runs these programs as LocalSystem.

.PARAMETER DataDir
    The sidecar's data directory (configuration, attester key,
    slashing-protection database, chain data, logs). Defaults to
    %ProgramData%\FerminuxValidator, the sidecar's own default, so its
    commands work without --data-dir. `fmx-validator.exe install` limits it to
    SYSTEM and Administrators (Users may read). Never deleted by
    uninstall.ps1 unless it is run with -RemoveData.

.PARAMETER AllowInboundP2P
    Off by default. The node runs in sentry mode: it finds peers through the
    bootnodes, keeps links to the known public nodes, and needs no inbound
    port. With this switch the node may also map its port on your router
    (UPnP) and a firewall rule lets TCP/UDP 30303 reach ferminux.exe. Running
    the installer again without it closes the rule again.

.PARAMETER NoKey
    Do not create an attester key now (for example, to import one from
    another machine with `fmx-validator.exe keys import`).

.PARAMETER NoStart
    Register the service but do not start it.

.NOTES
    Run from an elevated ("Run as Administrator") PowerShell prompt.
    Expects ferminux.exe and fmx-validator.exe next to this script, as the
    release zip lays them out.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute(
    'PSAvoidUsingWriteHost', '',
    Justification = 'This is an interactive console installer; Write-Host is the right tool for status output.')]
param(
    [string]$InstallDir = (Join-Path $env:ProgramFiles 'Ferminux'),
    [string]$DataDir = (Join-Path $env:ProgramData 'FerminuxValidator'),
    [switch]$AllowInboundP2P,
    [switch]$NoKey,
    [switch]$NoStart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ServiceName = 'FerminuxValidator'
$ServiceDisplayName = 'Ferminux Validator'
$Network = 'mainnet'
$FirewallRuleNames = @('Ferminux Validator (P2P inbound)', 'Ferminux Validator (P2P inbound) (UDP)')
$OurFiles = @('ferminux.exe', 'fmx-validator.exe')

# SIDs: SYSTEM, BUILTIN\Administrators, BUILTIN\Users, NT SERVICE\TrustedInstaller
$SidSystem = 'S-1-5-18'
$SidAdmins = 'S-1-5-32-544'
$SidUsers = 'S-1-5-32-545'
$SidTrustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Note {
    param([string]$Message)
    Write-Host "    $Message" -ForegroundColor DarkGray
}

function Set-AdminOnlyAcl {
    <#
        Replaces the folder's permissions: owner Administrators, full control
        for SYSTEM and Administrators, read and execute for Users, nothing
        inherited from the parent, all of it inherited by what is inside.
        The service runs these programs as LocalSystem, so nobody else may be
        able to replace them or drop a DLL next to them.
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not $PSCmdlet.ShouldProcess($Path, 'Restrict to SYSTEM and Administrators')) {
        return
    }
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $propagate = [Security.AccessControl.PropagationFlags]::None
    $allow = [Security.AccessControl.AccessControlType]::Allow
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($grant in @(@($SidSystem, 'FullControl'), @($SidAdmins, 'FullControl'), @($SidUsers, 'ReadAndExecute'))) {
        $sid = [Security.Principal.SecurityIdentifier]::new($grant[0])
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, $grant[1], $inherit, $propagate, $allow))
    }
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($SidAdmins))
    Set-Acl -LiteralPath $Path -AclObject $acl
    # anything already inside drops its own explicit permissions and takes the folder's
    foreach ($item in Get-ChildItem -LiteralPath $Path -Force) {
        & icacls.exe $item.FullName /reset /T /C /Q | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Could not reset the permissions of $($item.FullName) (icacls exit code $LASTEXITCODE)."
        }
    }
}

function Assert-NothingPlanted {
    <#
        After the lock-down, refuses when anything already in the folder was
        created by an account other than SYSTEM, Administrators,
        TrustedInstaller or this administrator: it could have been planted
        there to run as LocalSystem. (The sidecar applies the same rule to
        its data directory.)
    #>
    param([Parameter(Mandatory = $true)][string]$Path)
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $trusted = @($SidSystem, $SidAdmins, $SidTrustedInstaller, $me)
    foreach ($item in Get-ChildItem -LiteralPath $Path -Force -Recurse) {
        $owner = (Get-Acl -LiteralPath $item.FullName).GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($trusted -notcontains $owner) {
            $name = $owner
            try { $name = ([Security.Principal.SecurityIdentifier]::new($owner)).Translate([Security.Principal.NTAccount]).Value } catch { $name = $owner }
            throw "$($item.FullName) was created by $name, not by an administrator, so it may have been planted there. " +
                "Remove it (or choose another -InstallDir) and run install.ps1 again."
        }
    }
}

function Invoke-Sidecar {
    <# Runs fmx-validator.exe with the given arguments; throws when it fails. #>
    param([Parameter(Mandatory = $true)][string[]]$Arguments, [string]$What = 'fmx-validator.exe')
    & $script:SidecarBin @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$What failed (exit code $LASTEXITCODE); its own message is above."
    }
}

function Show-StartFailure {
    <# What the sidecar and the event log say about a service that did not start. #>
    Write-Host ''
    Write-Warning "$ServiceDisplayName did not start. What it recorded:"
    & $script:SidecarBin status --data-dir $DataDir --network $Network
    try {
        Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = $ServiceName } -MaxEvents 3 -ErrorAction Stop |
            Format-List TimeCreated, Message
    } catch {
        Write-Note 'No event log entries from FerminuxValidator yet.'
    }
    Write-Note "Logs: $(Join-Path $DataDir "$Network\logs")"
}

if (-not (Test-Administrator)) {
    throw 'install.ps1 must be run from an elevated PowerShell prompt (Run as Administrator). ' +
        'It installs a Windows service and writes under Program Files and ProgramData.'
}

$sourceDir = $PSScriptRoot
foreach ($name in $OurFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceDir $name))) {
        throw "Expected to find '$name' next to install.ps1. Run this script from the extracted release " +
            'folder (it must contain ferminux.exe, fmx-validator.exe and install.ps1 together).'
    }
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$DataDir = [IO.Path]::GetFullPath($DataDir)
$nodeBin = Join-Path $InstallDir 'ferminux.exe'
$script:SidecarBin = Join-Path $InstallDir 'fmx-validator.exe'

# 1. stop a running service, so its programs can be replaced
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing -and $existing.Status -ne 'Stopped') {
    Write-Step "Stopping the running $ServiceName service before upgrading"
    if ($PSCmdlet.ShouldProcess($ServiceName, 'Stop service')) {
        Stop-Service -Name $ServiceName -Force
        # the sidecar stops its node cleanly first, which can take a while
        $existing.WaitForStatus('Stopped', [TimeSpan]::FromMinutes(3))
    }
}

# 2. the program folder, locked to SYSTEM and Administrators before anything goes in
Write-Step "Installing the programs to $InstallDir"
if ($PSCmdlet.ShouldProcess($InstallDir, 'Create and restrict the program folder')) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Set-AdminOnlyAcl -Path $InstallDir
    Assert-NothingPlanted -Path $InstallDir
    foreach ($name in $OurFiles) {
        $dest = Join-Path $InstallDir $name
        # a fresh file takes the folder's permissions; an overwritten one would keep its old ones
        if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force }
        Copy-Item -LiteralPath (Join-Path $sourceDir $name) -Destination $dest
    }
}
Write-Note 'Only SYSTEM and Administrators can change this folder (Users may read and run).'

# 3. the service: the sidecar registers itself and writes its configuration
Write-Step "Registering the $ServiceDisplayName service"
$inbound = if ($AllowInboundP2P) { 'true' } else { 'false' }
if ($PSCmdlet.ShouldProcess($ServiceName, 'fmx-validator.exe install')) {
    Invoke-Sidecar -What "'fmx-validator.exe install'" -Arguments @(
        'install', '--data-dir', $DataDir, '--network', $Network,
        '--node-path', $nodeBin, "--allow-inbound=$inbound")
}

# the pre-release packaging put the programs in %ProgramData%\Ferminux\bin, where
# any local user can add files; the service no longer points there
$legacyBin = Join-Path $env:ProgramData 'Ferminux\bin'
if ((Test-Path -LiteralPath (Join-Path $legacyBin 'fmx-validator.exe')) -and $legacyBin -ne $InstallDir) {
    Write-Step "Removing the old program folder $legacyBin"
    if ($PSCmdlet.ShouldProcess($legacyBin, 'Remove old program folder')) {
        Remove-Item -LiteralPath $legacyBin -Recurse -Force
    }
}

# 4. the attester key
$keyFile = Join-Path $DataDir "$Network\keys\attester.json"
if (Test-Path -LiteralPath $keyFile) {
    Write-Step 'An attester key already exists; keeping it'
    & $script:SidecarBin keys show --data-dir $DataDir --network $Network
} elseif ($NoKey) {
    Write-Step 'No attester key yet (-NoKey)'
    Write-Note "Create or import one later: & '$script:SidecarBin' keys new --data-dir '$DataDir' --store-password"
} elseif ($PSCmdlet.ShouldProcess($keyFile, 'Create the attester key')) {
    Write-Step 'Creating the attester key'
    Write-Note 'Choose a password (12 characters or more). It is stored for the service with'
    Write-Note 'machine-scope DPAPI; keep your own copy with a backup of the key file.'
    & $script:SidecarBin keys new --data-dir $DataDir --network $Network --store-password
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'The attester key was not created. The service runs anyway and waits for one; create it with:'
        Write-Host "    & '$script:SidecarBin' keys new --data-dir '$DataDir' --store-password"
    }
}

# 5. networking
Write-Step 'Networking'
if ($AllowInboundP2P) {
    Write-Note 'Inbound peers allowed: the node may map port 30303 on your router (UPnP),'
    Write-Note 'and a firewall rule lets TCP/UDP 30303 reach ferminux.exe.'
    if ($PSCmdlet.ShouldProcess($FirewallRuleNames[0], 'Create firewall rules')) {
        foreach ($ruleName in $FirewallRuleNames) {
            Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
        }
        New-NetFirewallRule -DisplayName $FirewallRuleNames[0] -Direction Inbound -Protocol TCP -LocalPort 30303 `
            -Program $nodeBin -Action Allow -Profile Any | Out-Null
        New-NetFirewallRule -DisplayName $FirewallRuleNames[1] -Direction Inbound -Protocol UDP -LocalPort 30303 `
            -Program $nodeBin -Action Allow -Profile Any | Out-Null
    }
} else {
    Write-Note 'Sentry mode: the node finds peers through the bootnodes and keeps links to the'
    Write-Note 'known public nodes, all outbound. No inbound port is needed and none is opened.'
    foreach ($ruleName in $FirewallRuleNames) {
        if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
            if ($PSCmdlet.ShouldProcess($ruleName, 'Remove firewall rule')) {
                Remove-NetFirewallRule -DisplayName $ruleName
                Write-Note "Removed the firewall rule '$ruleName' from an earlier -AllowInboundP2P install."
            }
        }
    }
}

# 6. start
if ($NoStart) {
    Write-Step 'Not starting the service (-NoStart). Start it with: Start-Service FerminuxValidator'
} elseif ($PSCmdlet.ShouldProcess($ServiceName, 'Start service')) {
    Write-Step 'Starting the service'
    $started = $true
    try {
        Start-Service -Name $ServiceName -ErrorAction Stop
    } catch {
        $started = $false
        Write-Warning $_.Exception.Message
    }
    if ($started) {
        # the service reports RUNNING once its dashboard is up; give it a moment to settle
        Start-Sleep -Seconds 5
        $started = (Get-Service -Name $ServiceName).Status -eq 'Running'
    }
    if ($started) {
        & $script:SidecarBin status --data-dir $DataDir --network $Network
    } else {
        Show-StartFailure
    }
}

$dataArg = ''
if ($DataDir -ne [IO.Path]::GetFullPath((Join-Path $env:ProgramData 'FerminuxValidator'))) {
    $dataArg = " --data-dir '$DataDir'"
}
Write-Host ''
Write-Host "Ferminux Validator is installed: programs in $InstallDir, data in $DataDir." -ForegroundColor Green
Write-Host 'Next steps (this script never moves funds):' -ForegroundColor Green
Write-Host "  1. Back up $keyFile and its password somewhere other than this PC."
Write-Host '  2. Send about 1 FMX to the attester address above for transaction fees.'
Write-Host '  3. Once the ValidatorHub address is published, open your seat from your own wallet:'
Write-Host "       & '$script:SidecarBin' seat-proof$dataArg --owner <your wallet address>"
Write-Host "  Check on it any time:  & '$script:SidecarBin' status$dataArg   (it prints the dashboard address)"
