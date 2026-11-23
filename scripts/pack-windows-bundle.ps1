# Packs the Windows x64 programs and the Slipwing skill into an installable npm tarball.
# Usage: pwsh scripts/pack-windows-bundle.ps1 [-BrowserRepo ..\agent-browser] [-Out dist] [-DesktopExe PATH] [-BrowserExe PATH]
# Without -DesktopExe and -BrowserExe both are built here with cargo (Visual Studio C++ build tools required).
param(
    [string]$BrowserRepo = (Join-Path (Split-Path -Parent $PSScriptRoot) '..\agent-browser'),
    [string]$Out = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist'),
    [string]$DesktopExe,
    [string]$BrowserExe
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$BrowserRepo = (Resolve-Path $BrowserRepo).Path
$bundle = Get-Content (Join-Path $repo 'npm\bundle.json') -Raw | ConvertFrom-Json

function Find-VcVars {
    @('C:\Program Files\Microsoft Visual Studio', 'C:\Program Files (x86)\Microsoft Visual Studio') |
        Where-Object { Test-Path $_ } |
        ForEach-Object { Get-ChildItem $_ -Directory | ForEach-Object { Get-ChildItem $_.FullName -Directory } } |
        ForEach-Object { Join-Path $_.FullName 'VC\Auxiliary\Build\vcvars64.bat' } |
        Where-Object { Test-Path $_ } | Select-Object -First 1
}

function Build-Release([string]$manifest, [string]$package) {
    $vcvars = Find-VcVars
    if (-not $vcvars) { throw 'Visual Studio C++ build tools were not found; pass -DesktopExe and -BrowserExe instead.' }
    $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
    $what = if ($package) { "-p $package" } else { '' }
    & cmd.exe /c "call `"$vcvars`" >nul 2>&1 && cargo build --release --locked --manifest-path `"$manifest`" $what"
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed for $manifest" }
}

if (-not $DesktopExe) {
    Build-Release (Join-Path $repo 'Cargo.toml') 'agent-desktop'
    $DesktopExe = Join-Path $repo 'target\release\agent-desktop.exe'
}
if (-not $BrowserExe) {
    Build-Release (Join-Path $BrowserRepo 'cli\Cargo.toml') ''
    $BrowserExe = Join-Path $BrowserRepo 'cli\target\release\agent-browser.exe'
}
$mark = '+slipwing.' + $bundle.version
foreach ($exe in $DesktopExe, $BrowserExe) {
    $reported = (& $exe --version | Out-String).Trim()
    if (-not $reported.EndsWith($mark)) { throw "$exe reports '$reported'; its Cargo version must end in $mark." }
}

$null = New-Item -ItemType Directory -Force -Path $Out
$Out = (Resolve-Path -LiteralPath $Out).Path
$stage = Join-Path $repo ('tmp\slipwing-pack-' + [IO.Path]::GetRandomFileName())
$bin = New-Item -ItemType Directory -Path (Join-Path $stage 'bin')
$browserBin = New-Item -ItemType Directory -Path (Join-Path $stage 'browser\bin')
$scripts = New-Item -ItemType Directory -Path (Join-Path $stage 'scripts')

Copy-Item -LiteralPath $DesktopExe -Destination (Join-Path $bin.FullName 'agent-desktop-win32-x64.exe')
Copy-Item -LiteralPath $BrowserExe -Destination (Join-Path $browserBin.FullName 'agent-browser-win32-x64.exe')
Copy-Item -LiteralPath (Join-Path $repo 'npm\bin\workflow.js') -Destination $bin.FullName
Copy-Item -LiteralPath (Join-Path $repo 'npm\scripts\initialize-state.ps1') -Destination $scripts.FullName
foreach ($file in 'lib', 'skills', 'bundle.json') {
    Copy-Item -LiteralPath (Join-Path $repo "npm\$file") -Destination $stage -Recurse
}
Copy-Item -LiteralPath (Join-Path $repo 'LICENSE') -Destination $stage
$repoUrl = 'https://github.com/narmi924/slipwing'
$raw = 'https://raw.githubusercontent.com/narmi924/slipwing/personal/'
$readme = [IO.File]::ReadAllText((Join-Path $repo '.github\README.md'))
$readme = $readme.Replace('](../assets/slipwing-architecture.svg)', '](' + $raw + 'assets/slipwing-architecture.png)')
$readme = $readme.Replace('](../', '](' + $raw)
$readme = $readme.Replace('src="../', 'src="' + $raw)
$readme = $readme.Replace('](README.zh-CN.md)', '](' + $repoUrl + '/blob/personal/.github/README.zh-CN.md)')
$readme = $readme.Replace('](README.md)', '](' + $repoUrl + '#readme)')
[IO.File]::WriteAllText((Join-Path $stage 'README.md'), $readme)
$browser = Split-Path -Parent $browserBin.FullName
foreach ($file in 'skill-data', 'skills', 'LICENSE') {
    Copy-Item -LiteralPath (Join-Path $BrowserRepo $file) -Destination $browser -Recurse
}
Copy-Item -Path (Join-Path $BrowserRepo 'cli\src\native\a11y\LICENSE-axe-core*.txt') -Destination $browser

$manifest = [ordered]@{
    name = 'slipwing'
    version = $bundle.version
    description = 'Let any AI agent work in your Windows apps and browser in the background. A Windows build of agent-desktop and agent-browser.'
    license = 'Apache-2.0'
    repository = 'github:narmi924/slipwing'
    homepage = $repoUrl + '#readme'
    keywords = @('windows', 'ai-agent', 'computer-use', 'desktop-automation', 'browser-automation', 'ui-automation', 'mcp', 'agent-skills')
    bin = @{ slipwing = 'bin/workflow.js' }
    engines = @{ node = '>=22' }
    os = @('win32')
    cpu = @('x64')
    scripts = @{ postinstall = 'node bin/workflow.js skill --install' }
}
[IO.File]::WriteAllText((Join-Path $stage 'package.json'), ($manifest | ConvertTo-Json -Depth 4))
& npm.cmd pack $stage --pack-destination $Out --silent
if ($LASTEXITCODE -ne 0) { throw 'Could not pack Slipwing.' }
