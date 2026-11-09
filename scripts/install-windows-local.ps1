# Builds this checkout and installs it as the global agent-desktop command.
# Return to the published package with: npm install -g agent-desktop

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if ((& git -C $repo branch --show-current).Trim() -ne 'personal') { throw 'Install only from the personal branch.' }
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

$vcvars = @('C:\Program Files\Microsoft Visual Studio', 'C:\Program Files (x86)\Microsoft Visual Studio') |
    Where-Object { Test-Path $_ } |
    ForEach-Object { Get-ChildItem $_ -Directory | ForEach-Object { Get-ChildItem $_.FullName -Directory } } |
    ForEach-Object { Join-Path $_.FullName 'VC\Auxiliary\Build\vcvars64.bat' } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
if (-not $vcvars) { throw 'Visual Studio C++ build tools were not found.' }

Push-Location $repo
try {
    & cmd.exe /c "call `"$vcvars`" >nul 2>&1 && cargo build --release --locked -p agent-desktop"
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }
    $binary = Join-Path $repo 'target\release\agent-desktop.exe'

    $staging = Join-Path ([IO.Path]::GetTempPath()) "agent-desktop-install-$PID"
    New-Item -ItemType Directory -Force $staging | Out-Null
    try {
        $package = (& npm pack (Join-Path $repo 'npm') --pack-destination $staging --silent | Select-Object -Last 1).Trim()
        if ($LASTEXITCODE -ne 0) { throw "npm pack failed with exit code $LASTEXITCODE" }
        $env:AGENT_DESKTOP_BINARY_PATH = $binary
        & npm install -g (Join-Path $staging $package) --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
    } finally {
        Remove-Item Env:AGENT_DESKTOP_BINARY_PATH -ErrorAction SilentlyContinue
        Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
    }

    $installed = Join-Path (& npm root -g) 'agent-desktop\bin\agent-desktop-win32-x64.exe'
    if ((Get-FileHash $installed).Hash -ne (Get-FileHash $binary).Hash) {
        throw "The installed binary at $installed does not match this build."
    }
    Write-Output "Installed $installed"
} finally {
    Pop-Location
}
