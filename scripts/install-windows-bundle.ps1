# Installs Slipwing: agent-desktop with the slipwing command, and agent-browser, both built from the personal
# branches, plus a short slipwing skill entry for Claude Code and Codex.
#   irm https://github.com/narmi924/slipwing/releases/latest/download/install.ps1 | iex
# It replaces the official agent-desktop and agent-browser npm packages; to go back: npm install -g agent-desktop agent-browser
# Test switches: -Zip PATH (a local bundle), -Prefix DIR (an npm prefix instead of the global one), -SkillDir DIR, -NoSkill.
param(
    [string]$Zip,
    [string]$Release = 'https://github.com/narmi924/slipwing/releases/latest/download',
    [string]$Prefix,
    [string]$SkillDir,
    [switch]$NoSkill
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Say([string]$text) { Write-Host $text }
function Invoke-Npm([string[]]$words) {
    $all = $words + $(if ($Prefix) { @('--prefix', $Prefix) } else { @() }) + @('--no-fund', '--no-audit', '--loglevel', 'error')
    & npm.cmd @all
    if ($LASTEXITCODE -ne 0) { throw "npm $($words -join ' ') failed" }
}

if ([Environment]::Is64BitOperatingSystem -ne $true) { throw 'Slipwing needs 64-bit Windows.' }
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 22 or later is needed. Install it from https://nodejs.org or with: winget install OpenJS.NodeJS.LTS' }
$major = [int]((& node --version).TrimStart('v').Split('.')[0])
if ($major -lt 22) { throw "Node.js 22 or later is needed; this computer has $(& node --version)." }

$work = Join-Path $env:LOCALAPPDATA 'slipwing'
New-Item -ItemType Directory -Force $work | Out-Null
if (-not $Zip) {
    Say 'Downloading the bundle ...'
    $sums = Join-Path $work 'SHA256SUMS'
    Invoke-WebRequest "$Release/SHA256SUMS" -OutFile $sums -UseBasicParsing
    $line = (Get-Content $sums | Where-Object { $_ -match '\.zip$' } | Select-Object -First 1)
    if (-not $line) { throw 'SHA256SUMS names no bundle.' }
    $expected, $file = $line -split '\s+', 2
    $Zip = Join-Path $work $file.Trim()
    Invoke-WebRequest "$Release/$($file.Trim())" -OutFile $Zip -UseBasicParsing
    $actual = (Get-FileHash $Zip -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected.ToLower()) { Remove-Item $Zip -Force; throw "The download does not match SHA256SUMS ($actual)." }
}
$stage = Join-Path $work ([IO.Path]::GetFileNameWithoutExtension($Zip))
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive $Zip -DestinationPath $stage
$bundle = Get-Content (Join-Path $stage 'bundle.json') -Raw | ConvertFrom-Json
$root = if ($Prefix) { Join-Path $Prefix 'node_modules' } else { (& npm.cmd root -g).Trim() }

Say "Installing agent-browser $($bundle.agent_browser_npm) and replacing its program with this bundle's build ..."
Invoke-Npm @('install', '-g', "agent-browser@$($bundle.agent_browser_npm)")
$browser = Join-Path $root 'agent-browser'
$target = Join-Path $browser 'bin\agent-browser-win32-x64.exe'
if (Test-Path $target) { Move-Item $target "$target.previous" -Force }
Copy-Item (Join-Path $stage 'agent-browser-win32-x64.exe') $target -Force
foreach ($folder in 'skill-data', 'skills') {
    Remove-Item (Join-Path $browser $folder) -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item (Join-Path $stage "agent-browser-$folder") (Join-Path $browser $folder) -Recurse -Force
}

Say "Installing agent-desktop with the slipwing command ..."
$env:AGENT_DESKTOP_BINARY_PATH = Join-Path $stage 'agent-desktop-win32-x64.exe'
try { Invoke-Npm @('install', '-g', (Join-Path $stage 'agent-desktop.tgz')) } finally { Remove-Item Env:AGENT_DESKTOP_BINARY_PATH -ErrorAction SilentlyContinue }
$desktop = Join-Path $root 'agent-desktop'
foreach ($pair in @(@((Join-Path $desktop 'bin\agent-desktop-win32-x64.exe'), 'agent-desktop-win32-x64.exe'), @($target, 'agent-browser-win32-x64.exe'))) {
    if ((Get-FileHash $pair[0]).Hash -ne (Get-FileHash (Join-Path $stage $pair[1])).Hash) { throw "$($pair[0]) does not match the bundle." }
}

$workflow = Join-Path $desktop 'bin\workflow.js'
$env:AGENT_BROWSER_BIN = $target
& node $workflow --version
Remove-Item Env:AGENT_BROWSER_BIN -ErrorAction SilentlyContinue
if (-not $NoSkill) {
    $skillArgs = @($workflow, 'skill', '--install') + $(if ($SkillDir) { @('--dir', $SkillDir) } else { @() })
    & node @skillArgs
}
Say ''
Say "Installed Slipwing $($bundle.version). Tell your agent: use the slipwing skill."
Say 'Back to the official packages: npm install -g agent-desktop agent-browser'
