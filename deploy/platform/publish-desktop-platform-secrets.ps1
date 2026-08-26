[CmdletBinding()]
param(
    [string]$AdminContainer = 'starsnap-admin-server',
    [string]$HubContainer = 'starsnap-log-server',
    [string]$MailerContainer = 'starsnap-erp-smtp-mailer-1',
    [string]$Repository = 'starsnap/starsnap-website',
    [string]$GitHubEnvironment = 'production',
    [string]$Confirmation = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Confirmation -ne 'PUBLISH-PLATFORM-SECRETS') {
    throw 'Publishing the six required production values requires -Confirmation PUBLISH-PLATFORM-SECRETS.'
}

function Assert-RunningContainer([string]$ContainerName) {
    if ($ContainerName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$') {
        throw "Unexpected container name: $ContainerName"
    }
    $running = (& docker inspect --format '{{.State.Running}}' $ContainerName 2>$null)
    if ($LASTEXITCODE -ne 0 -or $running -ne 'true') {
        throw "Required source container is not running: $ContainerName"
    }
}

function Read-ContainerEnvironmentValue([string]$ContainerName, [string]$VariableName) {
    $prefix = "$VariableName="
    $matches = @(
        & docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' $ContainerName |
            Where-Object { $_.StartsWith($prefix, [System.StringComparison]::Ordinal) }
    )
    if ($LASTEXITCODE -ne 0 -or $matches.Count -ne 1) {
        throw "Expected exactly one $VariableName value in $ContainerName"
    }
    $value = $matches[0].Substring($prefix.Length)
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "$VariableName is empty in $ContainerName"
    }
    return $value
}

function Read-ContainerSecretFile([string]$ContainerName, [string]$Path) {
    $value = (& docker exec $ContainerName sh -ec 'test -s "$1" && cat "$1"' sh $Path)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($value)) {
        throw "Could not read required mounted credential file from $ContainerName"
    }
    return [string]$value
}

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

foreach ($containerName in @($AdminContainer, $HubContainer, $MailerContainer)) {
    Assert-RunningContainer $containerName
}

$secretValues = [ordered]@{
    PLATFORM_AWS_ACCESS_KEY_ID_VALUE = Read-ContainerEnvironmentValue $AdminContainer 'AWS_ACCESS_KEY_ID'
    PLATFORM_AWS_SECRET_ACCESS_KEY_VALUE = Read-ContainerEnvironmentValue $AdminContainer 'AWS_SECRET_ACCESS_KEY'
    PLATFORM_CLOUDFLARE_TEAM_DOMAIN_VALUE = Read-ContainerEnvironmentValue $HubContainer 'CLOUDFLARE_ACCESS_TEAM_DOMAIN'
    PLATFORM_CLOUDFLARE_AUDIENCE_VALUE = Read-ContainerEnvironmentValue $HubContainer 'CLOUDFLARE_ACCESS_AUDIENCE'
    PLATFORM_ERP_SMTP_USERNAME_VALUE = Read-ContainerSecretFile $MailerContainer '/run/starsnap-smtp-credentials/username'
    PLATFORM_ERP_SMTP_PASSWORD_VALUE = Read-ContainerSecretFile $MailerContainer '/run/starsnap-smtp-credentials/password'
}

foreach ($entry in $secretValues.GetEnumerator()) {
    Invoke-GhWithInput @('secret', 'set', $entry.Key, '--repo', $Repository, '--env', $GitHubEnvironment) $entry.Value
    Write-Output "Published GitHub production environment secret: $($entry.Key)"
}

foreach ($key in @($secretValues.Keys)) {
    $secretValues[$key] = $null
}

Write-Output 'Published the six required desktop platform values without printing them.'
