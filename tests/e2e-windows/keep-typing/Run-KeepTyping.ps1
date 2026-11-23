# Keep-typing check for the slipwing command. A note in front receives a character every 150 ms while slipwing fills
# and saves a register window behind it. It passes when the register saved once with the values, the note never lost
# the foreground, the cursor never moved, no key or click was injected from outside, and every typed character landed.
# It takes the foreground for about half a minute, so it refuses to start while someone is using the computer.
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\e2e-windows\keep-typing\Run-KeepTyping.ps1 [-AgentDesktop PATH]
# -AgentDesktop defaults to target\release\agent-desktop.exe when it exists, else the agent-desktop on PATH.
param([string]$AgentDesktop, [string]$Out, [int]$QuietSeconds = 60)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$here = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $here '..\..\..')).Path
if (-not $Out) { $Out = Join-Path ([IO.Path]::GetTempPath()) ('keep-typing-' + [guid]::NewGuid().ToString('N')) }
New-Item -ItemType Directory -Force $Out | Out-Null
if (-not $AgentDesktop) {
    $built = Join-Path $repo 'target\release\agent-desktop.exe'
    $AgentDesktop = if (Test-Path $built) { $built } else { (Get-Command agent-desktop -ErrorAction Stop).Source }
}

Add-Type -Namespace KeepTyping -Name Idle -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct LastInput { public uint Size; public uint Time; }
[DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LastInput info);
'@
$last = New-Object KeepTyping.Idle+LastInput
$last.Size = 8
[void][KeepTyping.Idle]::GetLastInputInfo([ref]$last)
$idle = ([Environment]::TickCount - $last.Time) / 1000
if ($idle -lt $QuietSeconds) {
    [ordered]@{ pass = $null; skipped = "the keyboard or mouse was used $([math]::Round($idle, 1)) s ago; run it when the computer has been idle for $QuietSeconds s" } | ConvertTo-Json
    exit 2
}

$register = $null
$typist = $null
try {
    $log = Join-Path $Out 'saves.jsonl'
    $register = Start-Process powershell.exe -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'register-window.ps1'), '-Log', $log, '-Seconds', '300')
    $until = (Get-Date).AddSeconds(20)
    while (-not ((& $AgentDesktop list-windows | ConvertFrom-Json).data | Where-Object { $_.title -eq 'Keep Typing Register' })) {
        if ((Get-Date) -gt $until) { throw 'The register window did not open.' }
        Start-Sleep -Milliseconds 200
    }

    $files = @{ out = (Join-Path $Out 'typist.json'); ready = (Join-Path $Out 'typist.ready'); stop = (Join-Path $Out 'typist.stop') }
    $typist = Start-Process powershell.exe -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'typist.ps1'),
        '-Out', "`"$($files.out)`"", '-ReadyFile', "`"$($files.ready)`"", '-StopFile', "`"$($files.stop)`"", '-Seconds', '120', '-Title', '"Keep Typing Note"')
    $until = (Get-Date).AddSeconds(20)
    while (-not (Test-Path $files.ready)) {
        if ($typist.HasExited -or (Get-Date) -gt $until) { throw 'The note did not take the foreground.' }
        Start-Sleep -Milliseconds 100
    }
    Start-Sleep -Milliseconds 800

    $script = Join-Path $Out 'register.js'
    @'
const w = "Keep Typing Register";
await desktop.fill(w, "Name", "Gulnar Ablimit");
await desktop.fill(w, "Phone", "0991-5550182");
await desktop.select(w, "Customer type", "Business");
await desktop.fill(w, "Note", "D6182 EMS E998878");
await desktop.check(w, "Invoice");
await desktop.click(w, "Save");
return await desktop.waitText(w, "Saved");
'@ | Set-Content -Path $script -Encoding UTF8
    $env:AGENT_DESKTOP_BIN = $AgentDesktop
    $started = Get-Date
    $reply = & node (Join-Path $repo 'npm\bin\workflow.js') run --file $script --allow-final 2>&1 | Out-String
    $seconds = ((Get-Date) - $started).TotalSeconds
    Start-Sleep -Milliseconds 1500
    Set-Content -Path $files.stop -Value 'stop'
    $until = (Get-Date).AddSeconds(20)
    while (-not (Test-Path $files.out)) {
        if ((Get-Date) -gt $until) { throw 'The note wrote no summary.' }
        Start-Sleep -Milliseconds 100
    }
} finally {
    foreach ($started in @($typist, $register)) {
        if ($started -and -not $started.HasExited) { Stop-Process -Id $started.Id -ErrorAction SilentlyContinue }
    }
}

$typed = Get-Content $files.out -Raw | ConvertFrom-Json
$saves = @(if (Test-Path $log) { Get-Content $log | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json } })
$problems = @()
if ($saves.Count -ne 1) { $problems += "the register saved $($saves.Count) times" }
elseif ($saves[0].name -ne 'Gulnar Ablimit' -or $saves[0].type -ne 'Business' -or -not $saves[0].invoice) { $problems += 'the saved entry has other values' }
if ($typed.focus_losses -ne 0) { $problems += "the note lost the foreground $($typed.focus_losses) times for $($typed.focus_lost_ms) ms" }
if ($typed.cursor_moves_not_by_hand -ne 0) { $problems += "the cursor moved $($typed.cursor_moves_not_by_hand) times" }
if (($typed.foreign_keys + $typed.foreign_mouse_buttons + $typed.foreign_wheel) -ne 0) { $problems += 'input was injected from outside the note' }
if (-not $typed.note_matches) { $problems += 'typed characters did not all land in the note' }
if ($typed.hand_keys -or $typed.hand_mouse) { $problems += 'someone touched the keyboard or mouse during the check; run it again' }
$verdict = [ordered]@{ pass = ($problems.Count -eq 0); problems = $problems; seconds = [math]::Round($seconds, 1); saves = $saves.Count; note = $typed; reply = $reply.Trim() }
$verdict | ConvertTo-Json -Depth 6
if ($problems.Count) { exit 1 }
