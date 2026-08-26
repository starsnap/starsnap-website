[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$StatePath,
    [switch]$PurgeGeneratedSnapshot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$allowedRoot = [System.IO.Path]::GetFullPath('E:\dev\starsnap\.codex-tmp\server-migration')
$resolvedStatePath = [System.IO.Path]::GetFullPath($StatePath)
$allowedPrefix = $allowedRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $resolvedStatePath.StartsWith($allowedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "StatePath must stay inside $allowedRoot"
}
if (-not (Test-Path -LiteralPath $resolvedStatePath -PathType Leaf)) {
    throw "Relay state does not exist: $resolvedStatePath"
}

$state = Get-Content -LiteralPath $resolvedStatePath -Raw | ConvertFrom-Json
$runDirectory = [System.IO.Path]::GetFullPath([string]$state.outputDirectory)
if (-not $runDirectory.StartsWith($allowedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing unexpected relay directory: $runDirectory"
}
if ([System.IO.Path]::GetDirectoryName($resolvedStatePath) -ne $runDirectory) {
    throw 'Relay state and generated directory do not match.'
}

$containerName = [string]$state.container
if ($containerName -notmatch '^starsnap-platform-transfer-\d{8}t\d{6}z$') {
    throw "Refusing unexpected relay container: $containerName"
}

$containerId = (& docker ps --all --quiet --filter "name=^/${containerName}$")
if ($containerId) {
    & docker stop --time 10 $containerName | Out-Null
    & docker rm $containerName | Out-Null
}

if ($PurgeGeneratedSnapshot) {
    $resolvedAllowedRoot = (Resolve-Path -LiteralPath $allowedRoot).Path
    $resolvedRunDirectory = (Resolve-Path -LiteralPath $runDirectory).Path
    $resolvedPrefix = $resolvedAllowedRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolvedRunDirectory.StartsWith($resolvedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Recursive cleanup target escaped the migration directory: $resolvedRunDirectory"
    }
    Remove-Item -LiteralPath $resolvedRunDirectory -Recurse -Force
    Write-Output 'Temporary encrypted snapshot and transfer secrets were removed from the desktop; original Docker database volumes remain intact.'
}
else {
    Write-Output "Temporary relay stopped; encrypted snapshot remains at $runDirectory"
}
