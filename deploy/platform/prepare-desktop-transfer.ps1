[CmdletBinding()]
param(
    [string]$OutputRoot = 'E:\dev\starsnap\.codex-tmp\server-migration',
    [string]$HubContainer = 'starsnap-log-postgres',
    [string]$ErpContainer = 'starsnap-erp-postgres-1',
    [string]$BindAddress = '192.168.1.2',
    [ValidateRange(1024, 65535)]
    [int]$Port = 48081,
    [string]$Repository = 'starsnap/starsnap-website',
    [string]$GitHubEnvironment = 'production',
    [switch]$PublishGitHubSecrets,
    [string]$Confirmation = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$allowedRoot = [System.IO.Path]::GetFullPath('E:\dev\starsnap\.codex-tmp')
$resolvedOutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
$allowedPrefix = $allowedRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $resolvedOutputRoot.StartsWith($allowedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputRoot must stay inside $allowedRoot"
}
if (-not $PublishGitHubSecrets) {
    throw 'Use -PublishGitHubSecrets only after approving the encrypted LAN transfer and temporary GitHub environment secrets.'
}
if ($Confirmation -ne 'FINAL-DESKTOP-WRITES-QUIESCED') {
    throw 'Final export requires -Confirmation FINAL-DESKTOP-WRITES-QUIESCED.'
}

$relayScript = Join-Path $PSScriptRoot 'relay-server.py'
if (-not (Test-Path -LiteralPath $relayScript -PathType Leaf)) {
    throw "Missing relay server: $relayScript"
}

foreach ($container in @($HubContainer, $ErpContainer)) {
    $running = (& docker inspect --format '{{.State.Running}}' $container 2>$null)
    if ($LASTEXITCODE -ne 0 -or $running -ne 'true') {
        throw "Required database container is not running: $container"
    }
}

$writerContainers = @(
    'starsnap-erp-web-1',
    'starsnap-erp-embedding-worker-1',
    'starsnap-admin-server',
    'starsnap-log-server'
)
foreach ($container in $writerContainers) {
    $running = (& docker inspect --format '{{.State.Running}}' $container 2>$null)
    if ($LASTEXITCODE -eq 0 -and $running -eq 'true') {
        throw "Desktop writer must be stopped before the final snapshot: $container"
    }
}

$runId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$outputDirectory = Join-Path $resolvedOutputRoot $runId
if (Test-Path -LiteralPath $outputDirectory) {
    throw "Refusing to reuse migration directory: $outputDirectory"
}
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

$hubDumpName = 'starsnap-hub.dump'
$erpDumpName = 'starsnap-erp.dump'
$manifestName = 'manifest.json'
$archiveName = 'starsnap-platform.tar'
$encryptedName = 'starsnap-platform.enc'
$hubDump = Join-Path $outputDirectory $hubDumpName
$erpDump = Join-Path $outputDirectory $erpDumpName
$manifestPath = Join-Path $outputDirectory $manifestName
$archivePath = Join-Path $outputDirectory $archiveName
$encryptedPath = Join-Path $outputDirectory $encryptedName
$passphrasePath = Join-Path $outputDirectory 'transfer-passphrase.secret'
$tokenPath = Join-Path $outputDirectory 'transfer-token.secret'
$statePath = Join-Path $outputDirectory 'relay-state.json'
$hubTemp = "/tmp/starsnap-hub-$runId.dump"
$erpTemp = "/tmp/starsnap-erp-$runId.dump"

try {
    & docker exec --user postgres $HubContainer pg_dump `
        --port 5433 --username starsnap --dbname starsnap_hub `
        --format custom --compress 9 --file $hubTemp
    if ($LASTEXITCODE -ne 0) { throw 'Hub database export failed.' }
    & docker cp "${HubContainer}:$hubTemp" $hubDump
    if ($LASTEXITCODE -ne 0) { throw 'Hub database copy failed.' }

    & docker exec --user postgres $ErpContainer pg_dump `
        --port 5432 --username mealops --dbname mealops `
        --format custom --compress 9 --file $erpTemp
    if ($LASTEXITCODE -ne 0) { throw 'ERP database export failed.' }
    & docker cp "${ErpContainer}:$erpTemp" $erpDump
    if ($LASTEXITCODE -ne 0) { throw 'ERP database copy failed.' }
}
finally {
    & docker exec --user postgres $HubContainer rm -f -- $hubTemp 2>$null | Out-Null
    & docker exec --user postgres $ErpContainer rm -f -- $erpTemp 2>$null | Out-Null
}

$hubCountText = (& docker exec --user postgres $HubContainer psql `
    --port 5433 --username starsnap --dbname starsnap_hub `
    --tuples-only --no-align --command 'SELECT count(*) FROM public.access_logs').Trim()
$erpCountText = (& docker exec --user postgres $ErpContainer psql `
    --port 5432 --username mealops --dbname mealops `
    --tuples-only --no-align `
    --command "SELECT (SELECT count(*) FROM public.products) || '|' || (SELECT count(*) FROM public.tenants) || '|' || (SELECT count(*) FROM public.schema_migrations)").Trim()
if ($hubCountText -notmatch '^\d+$' -or $erpCountText -notmatch '^\d+\|\d+\|\d+$') {
    throw 'Could not capture non-sensitive database verification counts.'
}
$erpCounts = $erpCountText.Split('|')

$hubFile = Get-Item -LiteralPath $hubDump
$erpFile = Get-Item -LiteralPath $erpDump
$manifest = [ordered]@{
    schemaVersion = 1
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    sourceHost = '192.168.1.2'
    databases = [ordered]@{
        hub = [ordered]@{
            file = $hubDumpName
            database = 'starsnap_hub'
            sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $hubDump).Hash.ToLowerInvariant()
            bytes = $hubFile.Length
            accessLogs = [long]$hubCountText
        }
        erp = [ordered]@{
            file = $erpDumpName
            database = 'mealops'
            sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $erpDump).Hash.ToLowerInvariant()
            bytes = $erpFile.Length
            products = [long]$erpCounts[0]
            tenants = [long]$erpCounts[1]
            schemaMigrations = [long]$erpCounts[2]
        }
    }
}
[System.IO.File]::WriteAllText(
    $manifestPath,
    ($manifest | ConvertTo-Json -Depth 6),
    [System.Text.UTF8Encoding]::new($false)
)

& tar.exe -cf $archivePath -C $outputDirectory $hubDumpName $erpDumpName $manifestName
if ($LASTEXITCODE -ne 0) { throw 'Creating the migration archive failed.' }

function New-RandomText([int]$ByteCount) {
    $bytes = [byte[]]::new($ByteCount)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

$passphrase = New-RandomText 48
$relayToken = New-RandomText 32
[System.IO.File]::WriteAllText($passphrasePath, $passphrase, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($tokenPath, $relayToken, [System.Text.UTF8Encoding]::new($false))

$opensslImage = 'docker.io/alpine/openssl:3.5.4@sha256:42c7389ef077aed0eb4e96d0abbd094083d701bbaff1313073b061c0c9cd8278'
& docker run --rm `
    --mount "type=bind,source=$outputDirectory,target=/transfer" `
    $opensslImage `
    enc -aes-256-cbc -salt -pbkdf2 -iter 250000 `
    -pass file:/transfer/transfer-passphrase.secret `
    -in /transfer/$archiveName `
    -out /transfer/$encryptedName
if ($LASTEXITCODE -ne 0) { throw 'Encrypting the migration archive failed.' }

$encryptedSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $encryptedPath).Hash.ToLowerInvariant()

function Invoke-GhWithInput([string[]]$Arguments, [string]$InputValue) {
    $gh = (Get-Command gh -ErrorAction Stop).Source
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $gh
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in $Arguments) {
        [void]$startInfo.ArgumentList.Add($argument)
    }
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $process.StandardInput.Write($InputValue)
    $process.StandardInput.Close()
    $standardError = $process.StandardError.ReadToEnd()
    [void]$process.StandardOutput.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        throw "GitHub CLI operation failed: $standardError"
    }
}

Invoke-GhWithInput @('secret', 'set', 'PLATFORM_TRANSFER_TOKEN_VALUE', '--repo', $Repository, '--env', $GitHubEnvironment) $relayToken
Invoke-GhWithInput @('secret', 'set', 'PLATFORM_TRANSFER_PASSPHRASE_VALUE', '--repo', $Repository, '--env', $GitHubEnvironment) $passphrase
Invoke-GhWithInput @('variable', 'set', 'PLATFORM_DATA_SHA256', '--repo', $Repository, '--env', $GitHubEnvironment) $encryptedSha

$relayContainer = "starsnap-platform-transfer-$runId".ToLowerInvariant()
if (& docker ps --all --quiet --filter "name=^/${relayContainer}$") {
    throw "Relay container already exists: $relayContainer"
}
$pythonImage = 'docker.io/library/python:3.13-alpine@sha256:540c7d91f98ff6880174c40e99067bf5941eb54d818a7a5e094d188b196a934d'
& docker run --detach `
    --name $relayContainer `
    --restart no `
    --publish "${BindAddress}:${Port}:8080" `
    --mount "type=bind,source=$relayScript,target=/app/relay-server.py,readonly" `
    --mount "type=bind,source=$encryptedPath,target=/transfer/$encryptedName,readonly" `
    --mount "type=bind,source=$tokenPath,target=/run/transfer-token,readonly" `
    --env ARCHIVE_PATH=/transfer/$encryptedName `
    --env TOKEN_FILE=/run/transfer-token `
    --env PORT=8080 `
    $pythonImage python /app/relay-server.py | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Starting the temporary LAN relay failed.' }

$deadline = [DateTime]::UtcNow.AddSeconds(30)
$ready = $false
do {
    try {
        $response = Invoke-WebRequest `
            -Uri "http://${BindAddress}:${Port}/starsnap-platform.enc" `
            -Method Head `
            -Headers @{ Authorization = "Bearer $relayToken" } `
            -TimeoutSec 3
        $ready = $response.StatusCode -eq 200
    }
    catch {
        Start-Sleep -Seconds 1
    }
} while (-not $ready -and [DateTime]::UtcNow -lt $deadline)
if (-not $ready) { throw 'The temporary LAN relay did not become ready.' }

foreach ($plainPath in @($archivePath, $hubDump, $erpDump, $manifestPath)) {
    Remove-Item -LiteralPath $plainPath -Force
}

$state = [ordered]@{
    schemaVersion = 1
    container = $relayContainer
    outputDirectory = $outputDirectory
    encryptedArchive = $encryptedPath
    encryptedSha256 = $encryptedSha
    bindAddress = $BindAddress
    port = $Port
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
}
[System.IO.File]::WriteAllText(
    $statePath,
    ($state | ConvertTo-Json -Depth 4),
    [System.Text.UTF8Encoding]::new($false)
)

$passphrase = $null
$relayToken = $null
Write-Output "Encrypted snapshot ready: sha256=$encryptedSha"
Write-Output "Temporary relay: http://${BindAddress}:${Port}/starsnap-platform.enc"
Write-Output "Relay state: $statePath"
