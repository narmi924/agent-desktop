# Asks the person in front of the screen to let one final step go. Runs under Windows PowerShell 5.1 (WPF).
# Prints one word: once | always | deny | timeout.
# Only a real mouse click counts: the choices are not buttons (nothing to invoke through UI Automation), keys do
# nothing, and a click whose mouse-down was synthesized (SendInput, mouse_event: anything a program sends) is ignored.
# -SelfTest once|always|deny raises that choice's own click handler as a person's click would, to check the answer reaches stdout.
param([string]$What, [string]$Routine = '', [string]$Details = '', [string]$Picture = '', [int]$Seconds = 120, [string]$SelfTest = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RealClick {
    delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
    static HookProc keep;
    static IntPtr hook;
    public static bool LastDownInjected = true;
    public static void Start() {
        keep = new HookProc(OnMouse);
        hook = SetWindowsHookEx(14, keep, GetModuleHandle(null), 0);
    }
    static IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam) {
        if (code >= 0 && wParam.ToInt32() == 0x0201) {
            int flags = Marshal.ReadInt32(lParam, 12);
            LastDownInjected = (flags & 0x03) != 0;
        }
        return CallNextHookEx(hook, code, wParam, lParam);
    }
}
'@
[RealClick]::Start()

$ink = [Windows.Media.Brushes]::Black
$paper = New-Object Windows.Media.SolidColorBrush ([Windows.Media.Color]::FromRgb(0xF6, 0xF3, 0xEC))
$signal = New-Object Windows.Media.SolidColorBrush ([Windows.Media.Color]::FromRgb(0xC8, 0x3A, 0x1E))
$window = New-Object Windows.Window
$window.Title = 'agent-desktop 请你确认'
$window.Topmost = $true
$window.WindowStyle = 'ToolWindow'
$window.ResizeMode = 'NoResize'
$window.SizeToContent = 'WidthAndHeight'
$window.WindowStartupLocation = 'CenterScreen'
$window.Background = $paper
$window.ShowActivated = $true
$panel = New-Object Windows.Controls.StackPanel
$panel.Margin = '22,18,22,18'
$panel.Width = 440
$window.Content = $panel

function Add-Text([string]$text, [double]$size, [bool]$bold, $brush) {
    $t = New-Object Windows.Controls.TextBlock
    $t.Text = $text; $t.FontSize = $size; $t.TextWrapping = 'Wrap'; $t.Foreground = $brush
    $t.FontFamily = 'Microsoft YaHei UI'; $t.Margin = '0,0,0,8'
    if ($bold) { $t.FontWeight = 'SemiBold' }
    [void]$panel.Children.Add($t)
}
Add-Text '这一步做了就收不回：' 13 $false $signal
Add-Text $What 18 $true $ink
if ($Routine) { Add-Text ('动作：' + $Routine) 13 $false $ink }
if ($Details) { Add-Text $Details 13 $false $ink }
if ($Picture -and (Test-Path $Picture)) {
    $img = New-Object Windows.Controls.Image
    $bmp = New-Object Windows.Media.Imaging.BitmapImage
    $bmp.BeginInit(); $bmp.UriSource = New-Object Uri $Picture; $bmp.CacheOption = 'OnLoad'; $bmp.EndInit()
    $img.Source = $bmp; $img.MaxHeight = 200; $img.Stretch = 'Uniform'; $img.Margin = '0,4,0,12'; $img.HorizontalAlignment = 'Left'
    [void]$panel.Children.Add($img)
}
$note = New-Object Windows.Controls.TextBlock
$note.FontSize = 12; $note.Foreground = [Windows.Media.Brushes]::DimGray; $note.Margin = '0,4,0,0'; $note.FontFamily = 'Microsoft YaHei UI'

$state = @{ answer = 'timeout' }
$choices = @{}
$row = New-Object Windows.Controls.StackPanel
$row.Orientation = 'Horizontal'
$row.Margin = '0,8,0,0'
function Add-Choice([string]$label, [string]$value, $fill, $text, [bool]$enabled) {
    $b = New-Object Windows.Controls.Border
    $b.Background = $fill; $b.Padding = '14,7,14,7'; $b.Margin = '0,0,10,0'; $b.Cursor = 'Hand'
    $b.BorderBrush = $ink; $b.BorderThickness = '1'
    $t = New-Object Windows.Controls.TextBlock
    $t.Text = $label; $t.Foreground = $text; $t.FontSize = 14; $t.FontFamily = 'Microsoft YaHei UI'
    $b.Child = $t
    if (-not $enabled) { $b.Opacity = 0.35; $b.Cursor = 'Arrow' }
    $b.Add_MouseLeftButtonUp({
        if (-not $enabled) { return }
        if ([RealClick]::LastDownInjected) { $note.Text = '只认真人用鼠标点的这一下。'; return }
        $state.answer = $value
        $window.Close()
    }.GetNewClosure())
    $choices[$value] = $b
    [void]$row.Children.Add($b)
}
Add-Choice '允许这一次' 'once' $ink $paper $true
Add-Choice '以后都允许这个动作' 'always' $paper $ink ([bool]$Routine)
Add-Choice '拒绝' 'deny' $paper $signal $true
[void]$panel.Children.Add($row)
[void]$panel.Children.Add($note)

$left = $Seconds
$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(1)
$timer.Add_Tick({
    $script:left = $script:left - 1
    if ($script:left -le 0) { $window.Close() } elseif (-not $note.Text -or $note.Text -like '*秒后*') { $note.Text = "$($script:left) 秒后不点就算拒绝。" }
})
$script:left = $Seconds
$timer.Start()
if ($SelfTest) {
    $window.Add_ContentRendered({
        [RealClick]::LastDownInjected = $false
        $up = New-Object Windows.Input.MouseButtonEventArgs ([Windows.Input.Mouse]::PrimaryDevice, 0, [Windows.Input.MouseButton]::Left)
        $up.RoutedEvent = [Windows.UIElement]::MouseLeftButtonUpEvent
        $choices[$SelfTest].RaiseEvent($up)
    })
}
[void]$window.ShowDialog()
[Console]::Out.WriteLine($state.answer)
