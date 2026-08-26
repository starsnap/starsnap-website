[CmdletBinding()]
param(
    [ValidateSet('Validate', 'Push')]
    [string]$Mode = 'Validate',
    [string]$Tag = ([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')),
    [string]$Registry = 'ghcr.io/starsnap',
    [string]$StarSnapRoot = 'E:\dev\starsnap',
    [string]$ErpRoot = 'E:\dev\bluesis\erp_v2',
    [string]$ErpWebDockerfile = (Join-Path $PSScriptRoot 'dockerfiles\erp-web.Dockerfile'),
    [string]$Repository = 'starsnap/starsnap-website',
    [string]$GitHubEnvironment = 'production',
    [string]$LiveSnsContainer = 'web',
    [string]$LiveAdminWebContainer = 'starsnap-admin-web',
    [string]$LiveAdminServerContainer = 'starsnap-admin-server',
    [string]$ArtifactRoot = '',
    [switch]$PublishGitHubVariables,
    [string]$Confirmation = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Tag -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$') {
    throw 'Tag contains unsupported registry characters.'
}
if ($Registry -notmatch '^[a-z0-9.-]+(?:/[a-z0-9._-]+)+$') {
    throw 'Registry must be a lowercase registry namespace.'
}
if ($Mode -eq 'Push' -and $Confirmation -ne 'PUSH-ARM64-PLATFORM-IMAGES') {
    throw 'Pushing images requires -Confirmation PUSH-ARM64-PLATFORM-IMAGES.'
}
if ($PublishGitHubVariables -and $Mode -ne 'Push') {
    throw 'GitHub variables can only be published with -Mode Push.'
}

$allowedArtifactRoot = [System.IO.Path]::GetFullPath((Join-Path $StarSnapRoot '.codex-tmp\server-migration-live-artifacts'))
$resolvedArtifactRoot = if ([string]::IsNullOrWhiteSpace($ArtifactRoot)) {
    $allowedArtifactRoot
}
else {
    [System.IO.Path]::GetFullPath($ArtifactRoot)
}
$allowedArtifactPrefix = $allowedArtifactRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if ($resolvedArtifactRoot -ne $allowedArtifactRoot -and
    -not $resolvedArtifactRoot.StartsWith($allowedArtifactPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "ArtifactRoot must stay inside $allowedArtifactRoot"
}
$artifactRunRoot = [System.IO.Path]::GetFullPath((Join-Path $resolvedArtifactRoot $Tag))
if (-not $artifactRunRoot.StartsWith($allowedArtifactPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Generated artifact context escaped the approved temporary directory.'
}
if (Test-Path -LiteralPath $artifactRunRoot) {
    throw "Refusing to reuse a live-artifact directory: $artifactRunRoot"
}

function Assert-RunningContainer([string]$ContainerName) {
    if ($ContainerName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$') {
        throw "Unexpected live container name: $ContainerName"
    }
    $running = (& docker inspect --format '{{.State.Running}}' $ContainerName 2>$null)
    if ($LASTEXITCODE -ne 0 -or $running -ne 'true') {
        throw "Required live container is not running: $ContainerName"
    }
}

function Copy-LiveArtifact(
    [string]$ContainerName,
    [string]$ContainerPath,
    [string]$Destination
) {
    & docker cp "${ContainerName}:$ContainerPath" $Destination
    if ($LASTEXITCODE -ne 0) {
        throw "Could not copy $ContainerPath from $ContainerName"
    }
}

function Copy-LiveDirectoryDereferenced(
    [string]$ContainerName,
    [string]$ContainerPath,
    [string]$Destination,
    [string]$ArchiveName
) {
    $archivePath = Join-Path $artifactRunRoot $ArchiveName
    $dockerPath = (Get-Command docker -ErrorAction Stop).Source
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $dockerPath
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in @('exec', $ContainerName, 'tar', '-chf', '-', '-C', $ContainerPath, '.')) {
        [void]$startInfo.ArgumentList.Add($argument)
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $errorTask = $process.StandardError.ReadToEndAsync()
    $archiveStream = [System.IO.File]::Create($archivePath)
    try {
        $process.StandardOutput.BaseStream.CopyTo($archiveStream)
    }
    finally {
        $archiveStream.Dispose()
    }
    $process.WaitForExit()
    $standardError = $errorTask.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) {
        throw "Could not archive $ContainerPath from ${ContainerName}: $standardError"
    }

    & tar.exe -xf $archivePath -C $Destination
    if ($LASTEXITCODE -ne 0) {
        throw "Could not extract the live artifact archive: $ArchiveName"
    }
}

function Get-ArtifactFingerprint([string]$Path) {
    $root = [System.IO.Path]::GetFullPath($Path)
    $lines = @(
        Get-ChildItem -LiteralPath $root -File -Recurse |
            Sort-Object FullName |
            ForEach-Object {
                $relative = [System.IO.Path]::GetRelativePath($root, $_.FullName).Replace('\', '/')
                $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
                "$relative`:$hash"
            }
    )
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
    return [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

foreach ($containerName in @($LiveSnsContainer, $LiveAdminWebContainer, $LiveAdminServerContainer)) {
    Assert-RunningContainer $containerName
}

$snsArtifactContext = Join-Path $artifactRunRoot 'sns-web'
$adminWebArtifactContext = Join-Path $artifactRunRoot 'admin-web'
$adminServerArtifactContext = Join-Path $artifactRunRoot 'admin-server'
$artifactDirectories = @(
    (Join-Path $snsArtifactContext 'html')
    (Join-Path $adminWebArtifactContext 'app')
    (Join-Path $adminWebArtifactContext 'serve')
    $adminServerArtifactContext
)
foreach ($directory in $artifactDirectories) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

Copy-LiveArtifact $LiveSnsContainer '/usr/share/nginx/html/.' (Join-Path $snsArtifactContext 'html')
$snsNginxConfig = Join-Path $snsArtifactContext 'default.conf'
Copy-LiveArtifact $LiveSnsContainer '/etc/nginx/conf.d/default.conf' $snsNginxConfig
$snsNginxText = Get-Content -LiteralPath $snsNginxConfig -Raw
$desktopApiProxy = 'proxy_pass http://master.hamtory.com:8080;'
$swarmApiProxy = 'proxy_pass http://starsnap-main_api:8080;'
$desktopProxyCount = ([regex]::Matches($snsNginxText, [regex]::Escape($desktopApiProxy))).Count
$swarmProxyCount = ([regex]::Matches($snsNginxText, [regex]::Escape($swarmApiProxy))).Count
if ($desktopProxyCount -eq 2 -and $swarmProxyCount -eq 0) {
    $snsNginxText = $snsNginxText.Replace($desktopApiProxy, $swarmApiProxy)
    [System.IO.File]::WriteAllText($snsNginxConfig, $snsNginxText, [System.Text.UTF8Encoding]::new($false))
}
elseif ($desktopProxyCount -ne 0 -or $swarmProxyCount -ne 2) {
    throw 'SNS live Nginx config did not have the expected two API/WebSocket proxy routes.'
}
Copy-LiveArtifact $LiveAdminWebContainer '/app/.' (Join-Path $adminWebArtifactContext 'app')
Copy-LiveDirectoryDereferenced $LiveAdminWebContainer '/usr/local/lib/node_modules/serve' (Join-Path $adminWebArtifactContext 'serve') 'admin-serve.tar'
Copy-LiveArtifact $LiveAdminServerContainer '/app/starsnap-admin.jar' (Join-Path $adminServerArtifactContext 'application.jar')

$provenance = [ordered]@{
    schemaVersion = 1
    capturedAtUtc = [DateTime]::UtcNow.ToString('o')
    artifacts = @(
        [ordered]@{
            name = 'starsnap-sns-web'
            container = $LiveSnsContainer
            sourceImage = (& docker inspect --format '{{.Config.Image}}' $LiveSnsContainer)
            sourceImageId = (& docker inspect --format '{{.Image}}' $LiveSnsContainer)
            fingerprint = Get-ArtifactFingerprint $snsArtifactContext
        },
        [ordered]@{
            name = 'starsnap-admin-web'
            container = $LiveAdminWebContainer
            sourceImage = (& docker inspect --format '{{.Config.Image}}' $LiveAdminWebContainer)
            sourceImageId = (& docker inspect --format '{{.Image}}' $LiveAdminWebContainer)
            fingerprint = Get-ArtifactFingerprint $adminWebArtifactContext
        },
        [ordered]@{
            name = 'starsnap-admin-server'
            container = $LiveAdminServerContainer
            sourceImage = (& docker inspect --format '{{.Config.Image}}' $LiveAdminServerContainer)
            sourceImageId = (& docker inspect --format '{{.Image}}' $LiveAdminServerContainer)
            fingerprint = Get-ArtifactFingerprint $adminServerArtifactContext
        }
    )
}
[System.IO.File]::WriteAllText(
    (Join-Path $artifactRunRoot 'provenance.json'),
    ($provenance | ConvertTo-Json -Depth 5),
    [System.Text.UTF8Encoding]::new($false)
)

$images = @(
    [ordered]@{
        Variable = 'PLATFORM_SNS_WEB_IMAGE'
        Name = 'starsnap-sns-web'
        Context = $snsArtifactContext
        Dockerfile = Join-Path $PSScriptRoot 'dockerfiles\live-sns-web.Dockerfile'
        BuildArgs = @()
        ControlledArtifact = $true
    },
    [ordered]@{
        Variable = 'PLATFORM_ADMIN_WEB_IMAGE'
        Name = 'starsnap-admin-web'
        Context = $adminWebArtifactContext
        Dockerfile = Join-Path $PSScriptRoot 'dockerfiles\live-static-node.Dockerfile'
        BuildArgs = @('APP_PORT=5174')
        ControlledArtifact = $true
    },
    [ordered]@{
        Variable = 'PLATFORM_ADMIN_SERVER_IMAGE'
        Name = 'starsnap-admin-server'
        Context = $adminServerArtifactContext
        Dockerfile = Join-Path $PSScriptRoot 'dockerfiles\live-java-jar.Dockerfile'
        BuildArgs = @('APP_PORT=8082', 'JAR_NAME=starsnap-admin.jar')
        ControlledArtifact = $true
    },
    [ordered]@{
        Variable = 'PLATFORM_HUB_WEB_IMAGE'
        Name = 'starsnap-log-web'
        Context = Join-Path $StarSnapRoot 'starsnap-hub\starsnap-hub-web'
        Dockerfile = 'Dockerfile'
        BuildArgs = @()
        ControlledArtifact = $false
    },
    [ordered]@{
        Variable = 'PLATFORM_HUB_SERVER_IMAGE'
        Name = 'starsnap-log-server'
        Context = Join-Path $StarSnapRoot 'starsnap-hub\starsnap-log-server'
        Dockerfile = 'Dockerfile'
        BuildArgs = @()
        ControlledArtifact = $false
    },
    [ordered]@{
        Variable = 'PLATFORM_ERP_WEB_IMAGE'
        Name = 'starsnap-erp-web'
        Context = Join-Path $ErpRoot 'apps\web'
        Dockerfile = $ErpWebDockerfile
        BuildArgs = @('SITE_ORIGIN=https://erp.starsnap.kr')
        ControlledArtifact = $false
    },
    [ordered]@{
        Variable = 'PLATFORM_ERP_SMTP_MAILER_IMAGE'
        Name = 'starsnap-erp-smtp-mailer'
        Context = Join-Path $ErpRoot 'apps\mailer'
        Dockerfile = 'Dockerfile'
        BuildArgs = @()
        ControlledArtifact = $false
    },
    [ordered]@{
        Variable = 'PLATFORM_ERP_EMBEDDING_WORKER_IMAGE'
        Name = 'starsnap-erp-embedding-worker'
        Context = Join-Path $ErpRoot 'apps\web'
        Dockerfile = 'embedding-worker.Dockerfile'
        BuildArgs = @()
        ControlledArtifact = $false
    }
)

foreach ($image in $images) {
    $context = [System.IO.Path]::GetFullPath([string]$image.Context)
    $dockerfileValue = [string]$image.Dockerfile
    $dockerfile = if ([System.IO.Path]::IsPathRooted($dockerfileValue)) {
        [System.IO.Path]::GetFullPath($dockerfileValue)
    }
    else {
        Join-Path $context $dockerfileValue
    }
    if (-not (Test-Path -LiteralPath $dockerfile -PathType Leaf)) {
        throw "Missing Dockerfile: $dockerfile"
    }
    if ([bool]$image.ControlledArtifact) {
        $artifactPrefix = $artifactRunRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
        if (-not $context.StartsWith($artifactPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Live artifact context escaped its generated directory: $context"
        }
    }
    else {
        $dockerignore = Join-Path $context '.dockerignore'
        if (-not (Test-Path -LiteralPath $dockerignore -PathType Leaf)) {
            throw "Refusing a build context without .dockerignore: $context"
        }
        $ignoreText = Get-Content -LiteralPath $dockerignore -Raw
        if ($ignoreText -notmatch '(?m)^\.env(?:\.\*)?\s*$') {
            throw "Docker context does not exclude environment files: $context"
        }
    }
}

$metadataRoot = [System.IO.Path]::GetFullPath((Join-Path $StarSnapRoot '.codex-tmp\server-migration-image-metadata'))
New-Item -ItemType Directory -Path $metadataRoot -Force | Out-Null
$published = [ordered]@{}

foreach ($image in $images) {
    $reference = "$Registry/$($image.Name):$Tag"
    $metadataPath = Join-Path $metadataRoot "$($image.Name)-$Tag.json"
    $arguments = @(
        'buildx', 'build',
        '--platform', 'linux/arm64',
        '--file', $(
            if ([System.IO.Path]::IsPathRooted([string]$image.Dockerfile)) {
                [System.IO.Path]::GetFullPath([string]$image.Dockerfile)
            }
            else {
                Join-Path ([string]$image.Context) ([string]$image.Dockerfile)
            }
        ),
        '--progress', 'plain'
    )
    foreach ($buildArgument in $image.BuildArgs) {
        $arguments += @('--build-arg', $buildArgument)
    }
    if ($Mode -eq 'Push') {
        $arguments += @(
            '--tag', $reference,
            '--metadata-file', $metadataPath,
            '--provenance=true',
            '--sbom=true',
            '--push'
        )
    }
    else {
        $arguments += @('--output', 'type=cacheonly')
    }
    $arguments += [string]$image.Context

    Write-Output "[$Mode] $($image.Name) for linux/arm64"
    & docker @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Image build failed: $($image.Name)"
    }

    if ($Mode -eq 'Push') {
        $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
        $digest = [string]$metadata.'containerimage.digest'
        if ($digest -notmatch '^sha256:[0-9a-f]{64}$') {
            throw "Build metadata did not contain an immutable digest: $($image.Name)"
        }
        $published[$image.Variable] = "$Registry/$($image.Name)@$digest"
    }
}

if ($Mode -eq 'Push') {
    foreach ($entry in $published.GetEnumerator()) {
        Write-Output "$($entry.Key)=$($entry.Value)"
        if ($PublishGitHubVariables) {
            $entry.Value | & gh variable set $entry.Key `
                --repo $Repository `
                --env $GitHubEnvironment
            if ($LASTEXITCODE -ne 0) {
                throw "Could not publish GitHub environment variable: $($entry.Key)"
            }
        }
    }
}

Write-Output "Platform image $Mode completed for $($images.Count) images."
