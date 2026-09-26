<#
.SYNOPSIS
    CI smoke test: starts the built ferminux.exe on a throwaway, local-only
    --dev network and checks that it both produces new blocks and re-imports
    its own chain data after a restart.

.DESCRIPTION
    This never touches chain 3961 or any public network. --dev mode disables
    p2p entirely (chain/cmd/utils/flags.go: "--dev mode can't use p2p
    networking") and uses an ephemeral single-signer Clique network whose
    genesis is generated in memory - it exists only to prove the binary
    starts, seals blocks and can reload a datadir, independent of mainnet
    genesis, bootnodes or peers.

.PARAMETER NodeExe
    Path to the built node binary (ferminux.exe or ferminux).

.PARAMETER Port
    Loopback HTTP-RPC port to use. Defaults to 8547.
#>
[CmdletBinding()]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute(
    'PSAvoidUsingWriteHost', '',
    Justification = 'CI log output; Write-Host is the right tool here.')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute(
    'PSUseShouldProcessForStateChangingFunctions', '',
    Justification = 'Internal helpers that start/stop a throwaway local devnet process inside one CI script, not exported cmdlets acting on durable state.')]
param(
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [int]$Port = 8547
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$nodeExe = (Resolve-Path -LiteralPath $NodeExe).Path
$dataDir = Join-Path ([IO.Path]::GetTempPath()) ('fmx-devnet-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

function Get-BlockNumber {
    param([int]$RpcPort)
    $body = '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$RpcPort" -Method Post -Body $body `
        -ContentType 'application/json' -TimeoutSec 5
    return [Convert]::ToInt64($resp.result, 16)
}

function Wait-ForRpc {
    param([int]$RpcPort, [int]$TimeoutSec = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            return Get-BlockNumber -RpcPort $RpcPort
        } catch {
            Start-Sleep -Seconds 1
        }
    }
    throw "Node RPC on port $RpcPort did not answer within $TimeoutSec s."
}

function Start-DevNode {
    $nodeArgs = @(
        '--dev', '--dev.period', '1',
        '--datadir', $dataDir,
        '--http', '--http.addr', '127.0.0.1', '--http.port', $Port, '--http.api', 'eth,net,web3',
        '--ipcdisable',
        '--verbosity', '2'
    )
    $stdout = Join-Path $dataDir ('stdout-' + [Guid]::NewGuid().ToString('N') + '.log')
    $stderr = Join-Path $dataDir ('stderr-' + [Guid]::NewGuid().ToString('N') + '.log')
    return Start-Process -FilePath $nodeExe -ArgumentList $nodeArgs -PassThru -NoNewWindow `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
}

function Stop-DevNode {
    param($Process)
    if ($Process -and -not $Process.HasExited) {
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
        $Process.WaitForExit(15000) | Out-Null
    }
}

$exitCode = 0
try {
    Write-Host "==> Starting a throwaway --dev network (datadir: $dataDir)"
    $proc = Start-DevNode
    try {
        $height1 = Wait-ForRpc -RpcPort $Port
        Write-Host "    initial height: $height1"
        Start-Sleep -Seconds 8
        $height2 = Get-BlockNumber -RpcPort $Port
        Write-Host "    height after 8s: $height2"
        if ($height2 -le $height1) {
            throw "Node did not produce new blocks (height stayed at $height1)."
        }
        Write-Host 'OK: node produces blocks.'
    } finally {
        Stop-DevNode -Process $proc
    }

    Start-Sleep -Seconds 2

    Write-Host '==> Restarting against the same datadir to check it imports existing blocks'
    $proc2 = Start-DevNode
    try {
        $height3 = Wait-ForRpc -RpcPort $Port
        Write-Host "    height on restart: $height3"
        if ($height3 -lt $height2) {
            throw "Node did not import its own chain data on restart (had $height2, now $height3)."
        }
        Write-Host 'OK: node imports its previously produced blocks on restart.'
    } finally {
        Stop-DevNode -Process $proc2
    }

    Write-Host '==> Devnet smoke test passed.'
} catch {
    Write-Host "FAIL: $($_.Exception.Message)" -ForegroundColor Red
    Get-ChildItem -Path $dataDir -Filter '*.log' -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "--- $($_.Name) ---"
        Get-Content -LiteralPath $_.FullName -ErrorAction SilentlyContinue | Select-Object -Last 60
    }
    $exitCode = 1
} finally {
    Remove-Item -LiteralPath $dataDir -Recurse -Force -ErrorAction SilentlyContinue
}

exit $exitCode
