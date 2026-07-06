[CmdletBinding()]
param(
  [string]$ConfigPath = '',
  [string]$SkillsPath = ''
)

$ErrorActionPreference = 'Stop'

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList
  )

  & $FilePath @ArgumentList 2>&1 | ForEach-Object { Write-Host $_ }
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath exited with code $LASTEXITCODE."
  }
}

function Resolve-InstallPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

function Resolve-OpenCodeConfigPath {
  param([string]$RequestedPath)

  if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
    return Resolve-InstallPath -Path $RequestedPath
  }

  $directory = Join-Path $env:USERPROFILE '.config\opencode'
  $jsonPath = Join-Path $directory 'opencode.json'
  $jsoncPath = Join-Path $directory 'opencode.jsonc'
  if ((Test-Path $jsonPath) -and (Test-Path $jsoncPath)) {
    throw "Both $jsonPath and $jsoncPath exist. Pass -ConfigPath explicitly so the installer cannot update the wrong file."
  }
  if (Test-Path $jsoncPath) {
    return $jsoncPath
  }
  return $jsonPath
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

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js 20 or newer is required.'
  }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw 'npm is required.'
  }

  $distPath = Join-Path $RepoRoot 'dist\src\index.js'
  $jsoncParserPath = Join-Path $RepoRoot 'node_modules\jsonc-parser\package.json'
  Push-Location $RepoRoot
  try {
    if (-not (Test-Path $jsoncParserPath)) {
      Write-Host "Installing dependencies in $RepoRoot ..."
      Invoke-CheckedCommand -FilePath 'npm' -ArgumentList @('install')
    }

    $needsBuild = -not (Test-Path $distPath)
    if (-not $needsBuild) {
      $distTime = (Get-Item $distPath).LastWriteTimeUtc
      $newerSource = Get-ChildItem (Join-Path $RepoRoot 'src') -Recurse -File -Filter '*.ts' |
        Where-Object { $_.LastWriteTimeUtc -gt $distTime } |
        Select-Object -First 1
      $needsBuild = $null -ne $newerSource
    }

    if ($needsBuild) {
      Write-Host "Building $RepoRoot ..."
      Invoke-CheckedCommand -FilePath 'npm' -ArgumentList @('run', 'build')
    }
  } finally {
    Pop-Location
  }

  if (-not (Test-Path $distPath)) {
    throw "Build did not produce $distPath"
  }
  return (Resolve-Path $distPath).Path
}

function Get-DirectoryManifest {
  param([Parameter(Mandatory = $true)][string]$Root)

  if (-not (Test-Path $Root -PathType Container)) {
    return ''
  }
  # Get-Item expands Windows 8.3 path segments; Resolve-Path can preserve them and
  # make otherwise identical relative manifests compare as different strings.
  $rootPath = (Get-Item -LiteralPath $Root).FullName.TrimEnd('\', '/')
  $entries = Get-ChildItem $rootPath -Recurse -File | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($rootPath.Length).TrimStart('\', '/')
    "$relative|$((Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash)"
  }
  return ($entries -join "`n")
}

function Install-OpenCodeSkill {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$DestinationRoot,
    [Parameter(Mandatory = $true)][string]$SkillName
  )

  $source = Join-Path $RepoRoot "skills\$SkillName"
  $skillFile = Join-Path $source 'SKILL.md'
  if (-not (Test-Path $skillFile -PathType Leaf)) {
    throw "Missing companion skill: $skillFile"
  }

  New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null
  $destination = Join-Path $DestinationRoot $SkillName
  if ((Get-DirectoryManifest -Root $source) -eq (Get-DirectoryManifest -Root $destination)) {
    Write-Host "OpenCode skill already up to date: $destination"
    return $destination
  }

  $suffix = [Guid]::NewGuid().ToString('N')
  $temporary = Join-Path $DestinationRoot ".$SkillName.$suffix.tmp"
  $backup = $null
  Copy-Item -LiteralPath $source -Destination $temporary -Recurse
  try {
    if (Test-Path $destination) {
      $timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
      $backupRoot = Join-Path $DestinationRoot '.installer-backups'
      New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
      $backup = Join-Path $backupRoot "$SkillName-$timestamp"
      Move-Item -LiteralPath $destination -Destination $backup
    }
    Move-Item -LiteralPath $temporary -Destination $destination
  } catch {
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
    if ($backup -and (Test-Path $backup) -and -not (Test-Path $destination)) {
      Move-Item -LiteralPath $backup -Destination $destination
    }
    throw
  }

  Write-Host "Installed OpenCode skill: $SkillName -> $destination"
  if ($backup) {
    Write-Host "Backup of previous skill: $backup"
  }
  return $destination
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$serverPath = Ensure-Build -RepoRoot $repoRoot
$resolvedConfigPath = Resolve-OpenCodeConfigPath -RequestedPath $ConfigPath
if ([string]::IsNullOrWhiteSpace($SkillsPath)) {
  $SkillsPath = Join-Path $env:USERPROFILE '.config\opencode\skills'
}
$resolvedSkillsPath = Resolve-InstallPath -Path $SkillsPath

$serverConfig = [ordered]@{
  type = 'local'
  command = @('node', $serverPath)
  enabled = $true
  environment = [ordered]@{
    CONFLUENCE_BASE_URL = '{env:CONFLUENCE_BASE_URL}'
    CONFLUENCE_DEPLOYMENT = '{env:CONFLUENCE_DEPLOYMENT}'
    CONFLUENCE_TOKEN = '{env:CONFLUENCE_TOKEN}'
    CONFLUENCE_EMAIL = '{env:CONFLUENCE_EMAIL}'
    CONFLUENCE_CONNECTION_ID = '{env:CONFLUENCE_CONNECTION_ID}'
    CONFLUENCE_ALLOWED_SPACES = '{env:CONFLUENCE_ALLOWED_SPACES}'
  }
}

# OpenCode uses the last matching permission rule, so the broad rule must stay first.
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

$update = [ordered]@{
  serverName = 'confluence_safe'
  serverConfig = $serverConfig
  permissions = $permissionEntries
}
$updatePath = Join-Path ([IO.Path]::GetTempPath()) ("opencode-confluence-update-" + [Guid]::NewGuid().ToString('N') + '.json')
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($updatePath, ($update | ConvertTo-Json -Depth 20), $utf8NoBom)

try {
  $configUpdater = Join-Path $PSScriptRoot 'update-opencode-config.mjs'
  Invoke-CheckedCommand -FilePath 'node' -ArgumentList @($configUpdater, $resolvedConfigPath, $updatePath, '--dry-run')
  Install-OpenCodeSkill -RepoRoot $repoRoot -DestinationRoot $resolvedSkillsPath -SkillName 'manage-confluence-safely' | Out-Null
  Invoke-CheckedCommand -FilePath 'node' -ArgumentList @($configUpdater, $resolvedConfigPath, $updatePath)
} finally {
  Remove-Item -LiteralPath $updatePath -Force -ErrorAction SilentlyContinue
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
    Write-Warning 'CONFLUENCE_EMAIL is required when CONFLUENCE_DEPLOYMENT=cloud.'
  }
} elseif (-not [string]::IsNullOrWhiteSpace($deployment) -and $deployment -ne 'data_center') {
  Write-Warning "CONFLUENCE_DEPLOYMENT should be set to 'cloud' or 'data_center'."
}

Write-Host "Installed MCP server: confluence_safe -> $serverPath"
Write-Host "Installed companion skill: manage-confluence-safely -> $resolvedSkillsPath"
Write-Host 'Restart OpenCode if it was already running.'
