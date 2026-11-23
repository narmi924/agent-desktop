$ErrorActionPreference = 'Stop'
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
$directory.Create($security)
