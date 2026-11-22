# Started hidden, Windows would keep the form hidden too; it shows itself without taking the foreground (SW_SHOWNOACTIVATE).
# A WinForms register window for the keep-typing check. Each Save appends one JSON line to -Log. The result line is a
# Label whose accessible name is "Result", so what it shows ("Saved C1") is only in the window's picture.
#   powershell -NoProfile -ExecutionPolicy Bypass -File register-window.ps1 -Log saves.jsonl [-Seconds 600]
param([Parameter(Mandatory = $true)][string]$Log, [int]$Seconds = 600)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Keep Typing Register'
$form.Size = New-Object System.Drawing.Size(440, 360)
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(720, 120)

function Add-Field([string]$label, [int]$y, $control) {
    $caption = New-Object System.Windows.Forms.Label
    $caption.Text = $label
    $caption.Location = New-Object System.Drawing.Point(24, $y)
    $caption.AutoSize = $true
    $form.Controls.Add($caption)
    $control.Location = New-Object System.Drawing.Point(130, ($y - 3))
    $control.Width = 250
    $control.AccessibleName = $label
    $form.Controls.Add($control)
    $control
}

$name = Add-Field 'Name' 30 (New-Object System.Windows.Forms.TextBox)
$phone = Add-Field 'Phone' 70 (New-Object System.Windows.Forms.TextBox)
$kind = Add-Field 'Customer type' 110 (New-Object System.Windows.Forms.ComboBox)
$kind.DropDownStyle = 'DropDownList'
[void]$kind.Items.AddRange(@('Person', 'Business'))
$note = Add-Field 'Note' 150 (New-Object System.Windows.Forms.TextBox)
$invoice = New-Object System.Windows.Forms.CheckBox
$invoice.Text = 'Invoice'
$invoice.Location = New-Object System.Drawing.Point(130, 185)
$invoice.AutoSize = $true
$form.Controls.Add($invoice)
$save = New-Object System.Windows.Forms.Button
$save.Text = 'Save'
$save.Location = New-Object System.Drawing.Point(130, 220)
$form.Controls.Add($save)
$result = New-Object System.Windows.Forms.Label
$result.AccessibleName = 'Result'
$result.Location = New-Object System.Drawing.Point(24, 265)
$result.AutoSize = $true
$form.Controls.Add($result)

$count = 0
$save.Add_Click({
    if (-not $name.Text.Trim() -or -not $kind.SelectedItem) { $result.Text = 'Name and type are required'; return }
    $script:count++
    $entry = [ordered]@{ at = (Get-Date).ToString('o'); id = 'C' + $script:count; name = $name.Text; phone = $phone.Text; type = [string]$kind.SelectedItem; note = $note.Text; invoice = $invoice.Checked }
    [System.IO.File]::AppendAllText($Log, (($entry | ConvertTo-Json -Compress) + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    $result.Text = 'Saved ' + $entry.id
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $Seconds * 1000
$timer.Add_Tick({ $form.Close() })
$timer.Start()
Add-Type -Namespace KeepTyping -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);'
$reveal = New-Object System.Windows.Forms.Timer
$reveal.Interval = 200
$reveal.Add_Tick({ $reveal.Stop(); [void][KeepTyping.Win]::ShowWindow($form.Handle, 4) })
$reveal.Start()
[void]$form.ShowDialog()
