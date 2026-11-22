# Keep-typing check. Shows a note window, takes the foreground and types into it steadily until -StopFile appears or
# -Seconds pass, then writes a JSON summary to -Out. While it runs, the tool under test works on other windows.
#   powershell -NoProfile -ExecutionPolicy Bypass -File typist.ps1 -Out result.json [-Seconds 60] [-IntervalMs 150]
#   -IntervalMs 0: it types nothing and only measures, while a person types into the note.
#   powershell -NoProfile -ExecutionPolicy Bypass -File typist.ps1 -CompileOnly
# It takes the foreground and sends keystrokes into its own note: run it only when nobody is using the computer.
param(
    [string]$Out = (Join-Path $PSScriptRoot 'result.json'),
    [string]$ReadyFile = (Join-Path $PSScriptRoot 'ready.txt'),
    [string]$StopFile = (Join-Path $PSScriptRoot 'stop.txt'),
    [int]$Seconds = 60,
    [int]$IntervalMs = 150,
    [string]$Text = 'the quick brown fox jumps over the lazy dog while the agent works elsewhere ',
    [string]$Title = "keep-typing note",
    [switch]$CompileOnly
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition (Get-Content (Join-Path $PSScriptRoot 'Typist.cs') -Raw) -ReferencedAssemblies System.Windows.Forms, System.Drawing
if ($CompileOnly) { Write-Output 'compiled'; exit 0 }
foreach ($f in $Out, $ReadyFile, $StopFile) { Remove-Item $f -Force -ErrorAction SilentlyContinue }
$code = [KeepTyping]::Run($Out, $ReadyFile, $StopFile, $Seconds, $IntervalMs, $Text, $Title)
if ($code -eq 2) { Write-Output '{"error":"the note could not take the foreground"}' }
exit $code
