[CmdletBinding()]
param(
    [ValidateSet('Switch', 'Restore')]
    [string]$Mode,
    [string]$StarSnapRoot = 'E:\dev\starsnap',
    [string]$ReleaseOverride = 'E:\dev\starsnap\.codex-tmp\docker-compose.ai-release.yaml',
    [string]$StatePath = 'E:\dev\starsnap\.codex-tmp\server-migration\ai-log-route-state.json',
    [string]$Confirmation = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$expectedConfirmation = if ($Mode -eq 'Switch') { 'SWITCH-DESKTOP-AI-LOG' } else { 'RESTORE-DESKTOP-AI-LOG' }
if ($Confirmation -ne $expectedConfirmation) {
    throw "$Mode requires -Confirmation $expectedConfirmation"
}

$baseCompose = Join-Path $StarSnapRoot 'starsnap-main\docker-compose.yaml'
$composeProjectDirectory = [System.IO.Path]::GetDirectoryName($baseCompose)
$targetOverride = Join-Path $PSScriptRoot 'desktop-ai-log-target.yml'
$restoreOverride = Join-Path $PSScriptRoot 'desktop-ai-log-restore.yml'
foreach ($path in @($baseCompose, $ReleaseOverride, $targetOverride, $restoreOverride)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Missing AI deployment file: $path"
    }
}

$allowedStateRoot = [System.IO.Path]::GetFullPath((Join-Path $StarSnapRoot '.codex-tmp\server-migration'))
$resolvedStatePath = [System.IO.Path]::GetFullPath($StatePath)
$statePrefix = $allowedStateRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $resolvedStatePath.StartsWith($statePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "StatePath must stay inside $allowedStateRoot"
}

$oldUrl = 'http://host.docker.internal:8081/api/server-logs'
$targetUrl = 'http://192.168.1.103:8081/api/server-logs'

function Read-AiLogUrl {
    $prefix = 'ACCESS_LOG_URL='
    $matches = @(
        & docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' ai-backend |
            Where-Object { $_.StartsWith($prefix, [System.StringComparison]::Ordinal) }
    )
    if ($LASTEXITCODE -ne 0 -or $matches.Count -gt 1) {
        throw 'Could not inspect the current AI log route.'
    }
    if ($matches.Count -eq 0) {
        return $null
    }
    return $matches[0].Substring($prefix.Length)
}

function Wait-AiHealthy([string]$ExpectedImageId, [string]$ExpectedUrl) {
    $deadline = [DateTime]::UtcNow.AddMinutes(5)
    do {
        $running = (& docker inspect --format '{{.State.Running}}' ai-backend 2>$null)
        $health = (& docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' ai-backend 2>$null)
        if ($running -eq 'true' -and $health -eq 'healthy') {
            $currentImageId = (& docker inspect --format '{{.Image}}' ai-backend)
            if ($currentImageId -ne $ExpectedImageId) {
                throw 'AI image changed while switching only its log route.'
            }
            if ((Read-AiLogUrl) -ne $ExpectedUrl) {
                throw 'AI log route did not converge to the expected URL.'
            }
            $mountNames = @(& docker inspect --format '{{range .Mounts}}{{println .Name}}{{end}}' ai-backend)
            if ($mountNames -notcontains 'starsnap-main_ai-insightface-cache') {
                throw 'AI InsightFace model cache volume was not preserved.'
            }
            $deviceRequests = (& docker inspect --format '{{json .HostConfig.DeviceRequests}}' ai-backend)
            if ($deviceRequests -notmatch '"gpu"') {
                throw 'AI GPU device request was not preserved.'
            }
            return
        }
        if ($running -eq 'false' -or $health -eq 'unhealthy') {
            & docker logs --tail 100 ai-backend 2>$null
            throw "AI container failed during log-route $Mode."
        }
        Start-Sleep -Seconds 3
    } while ([DateTime]::UtcNow -lt $deadline)
    & docker logs --tail 100 ai-backend 2>$null
    throw "Timed out waiting for AI health after log-route $Mode."
}

function Invoke-AiCompose([string]$RouteOverride, [string]$ExpectedImageId, [string]$ExpectedUrl) {
    $placeholderNames = @(
        'AI_INTERNAL_TOKEN'
        'AWS_ACCESS_KEY_ID'
        'AWS_SECRET_ACCESS_KEY'
        'HUB_SERVER_LOG_SECRET'
    )
    $previousValues = @{}
    try {
        foreach ($name in $placeholderNames) {
            $previousValues[$name] = [System.Environment]::GetEnvironmentVariable($name, 'Process')
            [System.Environment]::SetEnvironmentVariable($name, 'compose-scope-placeholder', 'Process')
        }
        & docker compose `
            --project-name starsnap-main `
            --project-directory $composeProjectDirectory `
            --file $baseCompose `
            --file $ReleaseOverride `
            --file $RouteOverride `
            up --detach --no-deps --force-recreate ai-backend
        if ($LASTEXITCODE -ne 0) {
            throw 'Docker Compose rejected the AI log-route update.'
        }
    }
    finally {
        foreach ($name in $placeholderNames) {
            [System.Environment]::SetEnvironmentVariable($name, $previousValues[$name], 'Process')
        }
    }
    Wait-AiHealthy $ExpectedImageId $ExpectedUrl
}

$running = (& docker inspect --format '{{.State.Running}}' ai-backend 2>$null)
if ($LASTEXITCODE -ne 0 -or $running -ne 'true') {
    throw 'The desktop AI container is not running.'
}
$imageId = (& docker inspect --format '{{.Image}}' ai-backend)
$currentUrl = Read-AiLogUrl

if ($Mode -eq 'Switch') {
    if ($currentUrl -eq $targetUrl) {
        if (-not (Test-Path -LiteralPath $resolvedStatePath -PathType Leaf)) {
            throw 'AI already uses the target Hub but its rollback marker is missing.'
        }
        Write-Output 'Desktop AI logging already uses the target Hub and rollback state is present.'
        exit 0
    }
    if ($null -ne $currentUrl -and $currentUrl -ne $oldUrl) {
        throw "Refusing to overwrite an unexpected AI log route: $currentUrl"
    }
    if (Test-Path -LiteralPath $resolvedStatePath) {
        throw "Refusing to overwrite AI log-route rollback state: $resolvedStatePath"
    }

    $hubHealth = Invoke-RestMethod -Uri 'http://192.168.1.103:8081/actuator/health' -TimeoutSec 10
    if ($hubHealth.status -ne 'UP') {
        throw 'The target Hub is not healthy over the desktop-to-server LAN route.'
    }

    New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($resolvedStatePath)) -Force | Out-Null
    $state = [ordered]@{
        schemaVersion = 1
        previousPresent = $null -ne $currentUrl
        previousUrl = if ($null -eq $currentUrl) { '' } else { $currentUrl }
        imageId = $imageId
        createdAtUtc = [DateTime]::UtcNow.ToString('o')
    }
    [System.IO.File]::WriteAllText(
        $resolvedStatePath,
        ($state | ConvertTo-Json -Depth 3),
        [System.Text.UTF8Encoding]::new($false)
    )

    try {
        Invoke-AiCompose $targetOverride $imageId $targetUrl
    }
    catch {
        $automaticRestoreSucceeded = $false
        try {
            Invoke-AiCompose $restoreOverride $imageId $oldUrl
            $automaticRestoreSucceeded = $true
        }
        catch {
            Write-Error 'AI log-route switch and automatic restore both failed.'
        }
        if ($automaticRestoreSucceeded) {
            [System.IO.File]::Delete($resolvedStatePath)
        }
        throw
    }
    Write-Output 'Desktop GPU AI worker now sends access logs to 192.168.1.103; image, GPU, and model cache were preserved.'
}
else {
    if (-not (Test-Path -LiteralPath $resolvedStatePath -PathType Leaf)) {
        if ($currentUrl -eq $targetUrl) {
            throw 'Cannot restore AI logging because rollback state is missing.'
        }
        Write-Output 'No desktop AI log-route rollback marker exists.'
        exit 0
    }
    $state = Get-Content -LiteralPath $resolvedStatePath -Raw | ConvertFrom-Json
    if ([string]$state.imageId -ne $imageId) {
        throw 'AI image changed after the log-route switch; refusing an implicit rollback.'
    }
    if ([bool]$state.previousPresent -and [string]$state.previousUrl -ne $oldUrl) {
        throw 'The saved AI log route is not the expected desktop Hub route.'
    }
    Invoke-AiCompose $restoreOverride $imageId $oldUrl
    [System.IO.File]::Delete($resolvedStatePath)
    Write-Output 'Desktop AI logging was restored to the pre-migration Hub route.'
}
