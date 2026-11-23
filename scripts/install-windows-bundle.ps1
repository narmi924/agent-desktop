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

function Get-NodeMajor {
    $found = Get-Command node -ErrorAction SilentlyContinue
    if (-not $found) { return 0 }
    try { return [int]((& $found.Source --version).TrimStart('v').Split('.')[0]) } catch { return 0 }
}

function Initialize-StateDirectory {
    $path = if ($env:AGENT_DESKTOP_HOME) { $env:AGENT_DESKTOP_HOME } else { Join-Path $env:USERPROFILE '.agent-desktop' }
    if ([IO.Path]::GetPathRoot($path).Length -lt 3) { throw 'AGENT_DESKTOP_HOME needs an absolute directory path.' }
    if (Test-Path -LiteralPath $path -PathType Container) { return }
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetAccessRuleProtection($true, $false)
    $account = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    foreach ($sid in @($account, [System.Security.Principal.SecurityIdentifier]'S-1-5-18', [System.Security.Principal.SecurityIdentifier]'S-1-5-32-544')) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        $security.AddAccessRule($rule)
    }
    $directory = [IO.DirectoryInfo]::new($path)
    if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::Create($directory, $security) }
    else { $directory.Create($security) }
}

if ([Environment]::Is64BitOperatingSystem -ne $true) { throw 'Slipwing needs 64-bit Windows.' }
$had = Get-NodeMajor
if ($had -lt 22) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    $found = if ($had) { "; this computer has Node.js $had" } else { '' }
    if (-not $winget) { throw "Slipwing needs Node.js 22 or later$found. Install the LTS from https://nodejs.org and run this again." }
    Say "Slipwing needs Node.js 22 or later$found. Installing the Node.js LTS with winget; Windows may ask for permission ..."
    $verb = if ($had) { 'upgrade' } else { 'install' }
    & $winget.Source $verb --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements
    $env:Path = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User')) -join ';'
    if ((Get-NodeMajor) -lt 22) { throw 'Node.js 22 or later could not be installed. Install the LTS from https://nodejs.org and run this again.' }
}

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
$previousDesktopBinary = $env:AGENT_DESKTOP_BINARY_PATH
try {
    $env:AGENT_DESKTOP_BINARY_PATH = Join-Path $stage 'agent-desktop-win32-x64.exe'
    Invoke-Npm @('install', '-g', (Join-Path $stage 'agent-desktop.tgz'))
} finally { $env:AGENT_DESKTOP_BINARY_PATH = $previousDesktopBinary }
$desktop = Join-Path $root 'agent-desktop'
foreach ($pair in @(@((Join-Path $desktop 'bin\agent-desktop-win32-x64.exe'), 'agent-desktop-win32-x64.exe'), @($target, 'agent-browser-win32-x64.exe'))) {
    if ((Get-FileHash $pair[0]).Hash -ne (Get-FileHash (Join-Path $stage $pair[1])).Hash) { throw "$($pair[0]) does not match the bundle." }
}

$workflow = Join-Path $desktop 'bin\workflow.js'
Initialize-StateDirectory
$previousBrowserBinary = $env:AGENT_BROWSER_BIN
try {
    $env:AGENT_BROWSER_BIN = $target
    & node $workflow --version
    if ($LASTEXITCODE -ne 0) { throw 'Slipwing was installed but could not start.' }
} finally { $env:AGENT_BROWSER_BIN = $previousBrowserBinary }
if (-not $NoSkill) {
    $skillArgs = @($workflow, 'skill', '--install') + $(if ($SkillDir) { @('--dir', $SkillDir) } else { @() })
    $result = & node @skillArgs
    if ($LASTEXITCODE -ne 0) { throw 'Slipwing was installed but its skill could not be installed. Run slipwing skill --install to try again.' }
    $skill = ($result | ConvertFrom-Json).data
    if ($skill.kept) { Say ("Kept the existing skill in " + ($skill.kept -join ', ') + ". Run slipwing skill to read the installed guide.") }
}
Say ''
Say "Installed Slipwing $($bundle.version)."
if (-not $NoSkill -and $skill.installed) { Say 'Tell your agent: use the slipwing skill.' }
Say 'Back to the official packages: npm install -g agent-desktop agent-browser'
