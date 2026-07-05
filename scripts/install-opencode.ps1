[CmdletBinding()]
param(
  [string]$ConfigPath = $(Join-Path $env:USERPROFILE '.config\opencode\opencode.json')
)

$ErrorActionPreference = 'Stop'

function Ensure-NoteProperty {
  param(
    [Parameter(Mandatory = $true)]$Object,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)]$Value
  )

  if ($null -eq $Object.PSObject.Properties[$Name]) {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
    return
  }

  $Object.PSObject.Properties[$Name].Value = $Value
}

function Get-MissingUserEnv {
  param([string[]]$Names)

  $missing = @()
  foreach ($name in $Names) {
    $value = [Environment]::GetEnvironmentVariable($name, 'User')
    if ([string]::IsNullOrWhiteSpace($value)) {
      $value = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    if ([string]::IsNullOrWhiteSpace($value)) {
      $missing += $name
    }
  }

  return $missing
}

function Ensure-Build {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)

  $distPath = Join-Path $RepoRoot 'dist\src\index.js'
  if (Test-Path $distPath) {
    return $distPath
  }

  Write-Host "dist/src/index.js is missing; building $RepoRoot ..."
  Push-Location $RepoRoot
  try {
    if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
      npm install
    }
    npm run build
  } finally {
    Pop-Location
  }

  if (-not (Test-Path $distPath)) {
    throw "Build did not produce $distPath"
  }

  return $distPath
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$serverPath = Ensure-Build -RepoRoot $repoRoot

$configDir = Split-Path -Parent $ConfigPath
if ($configDir) {
  New-Item -ItemType Directory -Force -Path $configDir | Out-Null
}

$rawConfig = if (Test-Path $ConfigPath) { Get-Content -Raw -Path $ConfigPath } else { '' }
if ([string]::IsNullOrWhiteSpace($rawConfig)) {
  $config = [pscustomobject]@{}
} else {
  try {
    $config = $rawConfig | ConvertFrom-Json
  } catch {
    throw "Could not parse existing OpenCode config at $ConfigPath. Fix or delete it, then rerun this script."
  }
}

if ($null -eq $config.PSObject.Properties['mcp']) {
  $config | Add-Member -NotePropertyName mcp -NotePropertyValue ([pscustomobject]@{})
}
if ($null -eq $config.PSObject.Properties['permission']) {
  $config | Add-Member -NotePropertyName permission -NotePropertyValue ([pscustomobject]@{})
}

$serverConfig = [pscustomobject]@{
  type = 'local'
  command = @('node', $serverPath)
  enabled = $true
  environment = [pscustomobject]@{
    CONFLUENCE_BASE_URL = '{env:CONFLUENCE_BASE_URL}'
    CONFLUENCE_DEPLOYMENT = '{env:CONFLUENCE_DEPLOYMENT}'
    CONFLUENCE_TOKEN = '{env:CONFLUENCE_TOKEN}'
    CONFLUENCE_EMAIL = '{env:CONFLUENCE_EMAIL}'
    CONFLUENCE_CONNECTION_ID = '{env:CONFLUENCE_CONNECTION_ID}'
    CONFLUENCE_ALLOWED_SPACES = '{env:CONFLUENCE_ALLOWED_SPACES}'
  }
}

Ensure-NoteProperty -Object $config.mcp -Name 'confluence_safe' -Value $serverConfig

$permissionEntries = [ordered]@{
  'confluence_safe_*' = 'ask'
  'confluence_safe_get_context' = 'allow'
  'confluence_safe_list_spaces' = 'allow'
  'confluence_safe_list_templates' = 'allow'
  'confluence_safe_get_template' = 'allow'
  'confluence_safe_search_content' = 'allow'
  'confluence_safe_get_content' = 'allow'
  'confluence_safe_propose_page_create' = 'allow'
  'confluence_safe_propose_page_create_from_page' = 'allow'
  'confluence_safe_propose_page_create_from_template' = 'allow'
  'confluence_safe_propose_page_update' = 'allow'
  'confluence_safe_get_changeset' = 'allow'
  'confluence_safe_discard_changeset' = 'allow'
}

foreach ($entry in $permissionEntries.GetEnumerator()) {
  Ensure-NoteProperty -Object $config.permission -Name $entry.Key -Value $entry.Value
}

$missing = Get-MissingUserEnv -Names @(
  'CONFLUENCE_BASE_URL',
  'CONFLUENCE_DEPLOYMENT',
  'CONFLUENCE_TOKEN',
  'CONFLUENCE_CONNECTION_ID',
  'CONFLUENCE_ALLOWED_SPACES'
)

if ($missing.Count -gt 0) {
  Write-Warning ("Missing user env vars: " + ($missing -join ', '))
  Write-Warning "Set them with [Environment]::SetEnvironmentVariable(..., 'User') before launching OpenCode."
}

$deployment = [Environment]::GetEnvironmentVariable('CONFLUENCE_DEPLOYMENT', 'User')
if ([string]::IsNullOrWhiteSpace($deployment)) {
  $deployment = [Environment]::GetEnvironmentVariable('CONFLUENCE_DEPLOYMENT', 'Process')
}

if ($deployment -eq 'cloud') {
  $cloudEmail = [Environment]::GetEnvironmentVariable('CONFLUENCE_EMAIL', 'User')
  if ([string]::IsNullOrWhiteSpace($cloudEmail)) {
    $cloudEmail = [Environment]::GetEnvironmentVariable('CONFLUENCE_EMAIL', 'Process')
  }
  if ([string]::IsNullOrWhiteSpace($cloudEmail)) {
    Write-Warning "CONFLUENCE_EMAIL is required when CONFLUENCE_DEPLOYMENT=cloud."
  }
} elseif (-not [string]::IsNullOrWhiteSpace($deployment) -and $deployment -ne 'data_center') {
  Write-Warning "CONFLUENCE_DEPLOYMENT should be set to 'cloud' or 'data_center'."
}

$config | ConvertTo-Json -Depth 20 | Set-Content -Path $ConfigPath -Encoding utf8

Write-Host "Updated OpenCode config: $ConfigPath"
Write-Host "Installed MCP server: confluence_safe -> $serverPath"
Write-Host "Restart OpenCode if it was already running."
