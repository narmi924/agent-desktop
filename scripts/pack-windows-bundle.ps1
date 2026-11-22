# Packs the Windows bundle: both programs built from the personal branches, the agent-desktop npm package with the
# workflow and its guide, the agent-browser guide files, bundle.json and install.ps1, into one zip with SHA256SUMS.
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

$name = "agent-desktop-windows-$($bundle.version)"
$stage = Join-Path $Out $name
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage | Out-Null

$tarball = (& npm pack (Join-Path $repo 'npm') --pack-destination $stage --silent | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0) { throw 'npm pack failed' }
Rename-Item (Join-Path $stage $tarball) 'agent-desktop.tgz'
Copy-Item $DesktopExe (Join-Path $stage 'agent-desktop-win32-x64.exe')
Copy-Item $BrowserExe (Join-Path $stage 'agent-browser-win32-x64.exe')
foreach ($folder in 'skill-data', 'skills') { Copy-Item (Join-Path $BrowserRepo $folder) (Join-Path $stage "agent-browser-$folder") -Recurse }
$browserVersion = (Get-Content (Join-Path $BrowserRepo 'package.json') -Raw | ConvertFrom-Json).version
$bundle | Add-Member -NotePropertyName 'agent_browser_npm' -NotePropertyValue $browserVersion -Force
$bundle | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $stage 'bundle.json') -Encoding UTF8
Copy-Item (Join-Path $PSScriptRoot 'install-windows-bundle.ps1') (Join-Path $stage 'install.ps1')

$zip = Join-Path $Out "$name.zip"
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
$sums = Join-Path $Out 'SHA256SUMS'
"$((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower())  $name.zip" | Set-Content $sums -Encoding ASCII
Copy-Item (Join-Path $PSScriptRoot 'install-windows-bundle.ps1') (Join-Path $Out 'install.ps1')
Write-Output "Packed $zip ($([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB), SHA256SUMS and install.ps1 in $Out"
