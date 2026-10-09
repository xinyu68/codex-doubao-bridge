param(
    [string]$SkillHome,
    [switch]$SkipMcpRegister,
    [switch]$ReplaceExisting
)
$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $PSScriptRoot
$nodePath = (Get-Command node -ErrorAction Stop).Source
if (-not $SkillHome) {
    $codexDirectory = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    $SkillHome = Join-Path $codexDirectory 'skills'
}
$mcpPath = Join-Path $bridgeRoot 'mcp-server.mjs'
if (-not $SkipMcpRegister) {
    Get-Command codex -ErrorAction Stop | Out-Null
    $previousErrorPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $existingJson = & codex mcp get doubao_local --json 2>$null
        $lookupExitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousErrorPreference }
    if ($lookupExitCode -eq 0) {
        $existing = ($existingJson -join "`n") | ConvertFrom-Json
        $sameInstallation = $existing.transport.type -eq 'stdio' -and @($existing.transport.args) -contains $mcpPath
        if (-not $sameInstallation -and -not $ReplaceExisting) {
            throw 'doubao_local already points to another installation. Use -ReplaceExisting only when intentionally migrating.'
        }
    }
}
$setupArguments = @((Join-Path $PSScriptRoot 'setup.mjs'), '--skill-home', $SkillHome)
if ($ReplaceExisting) { $setupArguments += '--replace-existing' }
& $nodePath @setupArguments
if ($LASTEXITCODE -ne 0) { throw 'Bridge setup failed.' }
if (-not $SkipMcpRegister) {
    if (-not $sameInstallation) {
        & codex mcp add doubao_local -- $nodePath $mcpPath
        if ($LASTEXITCODE -ne 0) { throw 'MCP registration failed. The prepared local configuration is retained.' }
    }
    Write-Output 'MCP registered. Reopen the Codex task to refresh tools and Skill discovery.'
}
Write-Output "Load the unpacked Chrome extension from: $(Join-Path $bridgeRoot 'extension')"
Write-Output 'Open Doubao and sign in. The service starts on demand; no scheduled task or login startup was created.'
