<#
.SYNOPSIS
    Uninstalls the Ferminux Validator Windows service.

.DESCRIPTION
    Stops the FerminuxValidator service (the sidecar stops its node cleanly
    first), removes it with `fmx-validator.exe uninstall` (which also removes
    its event log source), removes the firewall rules an -AllowInboundP2P
    install created, and deletes ferminux.exe and fmx-validator.exe from
    -InstallDir.

    The data directory (attester key, slashing-protection database, chain
    data, logs) is left in place unless -RemoveData is given: the key and its
    slashing-protection history belong together, and deleting them is how a
    key ends up used again without its history.

.PARAMETER InstallDir
    Must match the -InstallDir used at install time. Defaults to
    %ProgramFiles%\Ferminux.

.PARAMETER DataDir
    Must match the -DataDir used at install time. Defaults to
    %ProgramData%\FerminuxValidator.

.PARAMETER RemoveData
    Also deletes the data directory, including the attester key, after
    asking. It does not touch the seat or its deposit on chain.

.PARAMETER Force
    With -RemoveData: delete without asking.

.NOTES
    Run from an elevated ("Run as Administrator") PowerShell prompt.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute(
    'PSAvoidUsingWriteHost', '',
    Justification = 'This is an interactive console uninstaller; Write-Host is the right tool for status output.')]
param(
    [string]$InstallDir = (Join-Path $env:ProgramFiles 'Ferminux'),
    [string]$DataDir = (Join-Path $env:ProgramData 'FerminuxValidator'),
    [switch]$RemoveData,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ServiceName = 'FerminuxValidator'
$FirewallRuleNames = @('Ferminux Validator (P2P inbound)', 'Ferminux Validator (P2P inbound) (UDP)')
$OurFiles = @('ferminux.exe', 'fmx-validator.exe')

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

if (-not (Test-Administrator)) {
    throw 'uninstall.ps1 must be run from an elevated PowerShell prompt (Run as Administrator).'
}

$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$DataDir = [IO.Path]::GetFullPath($DataDir)
$sidecarBin = Join-Path $InstallDir 'fmx-validator.exe'
# the pre-release packaging's program folder, where the service may still point
$legacyBin = Join-Path $env:ProgramData 'Ferminux\bin'
if (-not (Test-Path -LiteralPath $sidecarBin) -and (Test-Path -LiteralPath (Join-Path $legacyBin 'fmx-validator.exe'))) {
    $sidecarBin = Join-Path $legacyBin 'fmx-validator.exe'
}

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
    if ($service.Status -ne 'Stopped') {
        Write-Step "Stopping the $ServiceName service"
        if ($PSCmdlet.ShouldProcess($ServiceName, 'Stop service')) {
            Stop-Service -Name $ServiceName -Force
            $service.WaitForStatus('Stopped', [TimeSpan]::FromMinutes(3))
        }
    }
    Write-Step 'Removing the service'
    if ($PSCmdlet.ShouldProcess($ServiceName, 'Remove service')) {
        $removed = $false
        if (Test-Path -LiteralPath $sidecarBin) {
            & $sidecarBin uninstall
            $removed = $LASTEXITCODE -eq 0
        }
        if (-not $removed) {
            Write-Host '    fmx-validator.exe was not available or failed; removing the service with sc.exe.' -ForegroundColor DarkGray
            & sc.exe delete $ServiceName | Out-Null
            if ($LASTEXITCODE -ne 0) {
                throw "sc.exe delete $ServiceName failed (exit code $LASTEXITCODE)."
            }
        }
    }
} else {
    Write-Step "No $ServiceName service is registered"
}

Write-Step 'Removing the firewall rules from an -AllowInboundP2P install, if any'
foreach ($ruleName in $FirewallRuleNames) {
    if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
        if ($PSCmdlet.ShouldProcess($ruleName, 'Remove firewall rule')) {
            Remove-NetFirewallRule -DisplayName $ruleName
        }
    }
}

foreach ($dir in @($InstallDir, $legacyBin)) {
    $present = @($OurFiles | Where-Object { Test-Path -LiteralPath (Join-Path $dir $_) })
    if ($present.Count -eq 0) {
        continue
    }
    Write-Step "Removing the programs from $dir"
    if ($PSCmdlet.ShouldProcess($dir, 'Remove ferminux.exe and fmx-validator.exe')) {
        foreach ($name in $present) {
            Remove-Item -LiteralPath (Join-Path $dir $name) -Force
        }
        # the folder goes too once nothing else is in it
        if (-not (Get-ChildItem -LiteralPath $dir -Force)) {
            Remove-Item -LiteralPath $dir -Force
        }
    }
}

if ($RemoveData) {
    if (Test-Path -LiteralPath $DataDir) {
        Write-Host ''
        Write-Warning ("This deletes $DataDir, including the attester key and its slashing-protection " +
            'database. The seat and its deposit on chain are not affected, but a key that is not backed up ' +
            'elsewhere is gone for good.')
        if ($PSCmdlet.ShouldProcess($DataDir, 'Delete the data directory (attester key, slashing protection, chain data)')) {
            if ($Force -or $PSCmdlet.ShouldContinue("Delete $DataDir, including the attester key?", 'Delete validator data')) {
                Remove-Item -LiteralPath $DataDir -Recurse -Force
                Write-Host "Removed $DataDir." -ForegroundColor Yellow
            } else {
                Write-Host "Kept $DataDir." -ForegroundColor Green
            }
        }
    }
} elseif (Test-Path -LiteralPath $DataDir) {
    Write-Host ''
    Write-Host "Kept $DataDir (attester key, slashing-protection database, chain data)." -ForegroundColor Green
    Write-Host 'Run again with -RemoveData only if you really want that deleted too.' -ForegroundColor Green
}

Write-Host ''
Write-Host 'Ferminux Validator uninstalled.' -ForegroundColor Green
Write-Host 'Your seat and its 2,000 FMX deposit are on chain and were not touched. To get the deposit back,'
Write-Host 'request an exit from the owner wallet; it can be withdrawn after the 14-day unbonding period.'
