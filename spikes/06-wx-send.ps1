# Checks operating WeChat through its normal UI, using simulated keyboard input only.
# Every mode refuses to start unless File Transfer Assistant is already the open chat,
# so a misfire can't reach a real conversation. There is no way to name another target.
# Text is typed character by character, so the clipboard is never touched.
#   powershell -File 06-wx-send.ps1 -SelfTest         test the checks on generated images, no WeChat
#   powershell -File 06-wx-send.ps1 -Mode Type        type into the input box, you press Enter
#   powershell -File 06-wx-send.ps1 -Mode Send        type and press Enter
#   powershell -File 06-wx-send.ps1 -Mode Navigate    open the chat through WeChat search
param(
    [ValidateSet('Type', 'Send', 'Navigate')][string]$Mode = 'Type',
    [string]$Text,
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'wx-common.ps1')

# Chinese by default because OCR couldn't read back the Latin "M0 test".
if (-not $Text) { $Text = ConvertFrom-CodePoints 0x67A2, 0x53D1, 0x9001, 0x6D4B, 0x8BD5 }   # "Shu send test"

$VK_CONTROL = [byte]0x11; $VK_MENU = [byte]0x12; $VK_RETURN = [byte]0x0D; $VK_F = [byte]0x46
$target = ConvertFrom-CodePoints 0x6587, 0x4EF6, 0x4F20, 0x8F93, 0x52A9, 0x624B   # File Transfer Assistant
$outputDir = Join-Path $PSScriptRoot 'output'
New-Item -ItemType Directory -Force $outputDir | Out-Null

function Read-WindowLines($window) {
    $path = Join-Path $outputDir 'wx-send-check.png'
    try {
        Save-WindowImage $window $path | Out-Null
        Read-OcrAll $path
    } finally { Remove-Item $path -ErrorAction SilentlyContinue }
}

function Read-EditArea($window) {
    $path = Join-Path $outputDir 'wx-send-check.png'
    try {
        Save-WindowImage $window $path | Out-Null
        Read-EditAreaLines $path $window
    } finally { Remove-Item $path -ErrorAction SilentlyContinue }
}

function Test-OpenChat($window) {
    $path = Join-Path $outputDir 'wx-send-check.png'
    try {
        Save-WindowImage $window $path | Out-Null
        Test-ChatTitle (Read-HeaderLines $path $window) $window $target
    } finally { Remove-Item $path -ErrorAction SilentlyContinue }
}

function Assert-Foreground($window) {
    if ([Win]::GetForegroundWindow() -ne $window.Handle) { throw 'WeChat lost focus. Stopped before sending any more input.' }
}

# A line break typed into WeChat acts as Enter and would send the message.
function Send-Text($window, [string]$value) {
    if ($value -match '[\x00-\x1F]') { throw 'Text contains a line break or control character. Nothing was typed.' }
    foreach ($character in $value.ToCharArray()) {
        Assert-Foreground $window
        if (-not [Win]::TypeChar($character)) { throw 'Windows rejected the simulated input.' }
        Start-Sleep -Milliseconds 40
    }
}

function Invoke-SelfTest {
    $window = [pscustomobject]@{ Width = 1000; Height = 700; ColumnWidth = 370; HeaderHeight = 100 }
    $misread = ConvertFrom-CodePoints 0x6587, 0x4EF6, 0x4F20, 0x8753, 0x808B, 0x624B   # two characters wrong
    $unrelated = ConvertFrom-CodePoints 0x9879, 0x76EE, 0x5468, 0x4F1A, 0x7FA4
    function New-Lines($items) {
        $path = Join-Path $outputDir 'selftest.png'
        $image = New-Object System.Drawing.Bitmap $window.Width, $window.Height
        $graphics = [System.Drawing.Graphics]::FromImage($image)
        $graphics.Clear([System.Drawing.Color]::White)
        $font = New-Object System.Drawing.Font 'Microsoft YaHei', 20, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
        foreach ($item in $items) { $graphics.DrawString($item.Text, $font, [System.Drawing.Brushes]::Black, $item.X, $item.Y) }
        $graphics.Dispose(); $image.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $image.Dispose()
        try { Read-OcrAll $path } finally { Remove-Item $path }
    }
    $checks = @(
        @{ Name = 'title in chat header accepted'; Expected = $true
           Actual = { Test-ChatTitle (New-Lines @(@{ Text = $target; X = 400; Y = 25 })) $window $target } }
        @{ Name = 'same name in session list rejected'; Expected = $false
           Actual = { Test-ChatTitle (New-Lines @(@{ Text = $target; X = 80; Y = 25 })) $window $target } }
        @{ Name = 'longer chat name rejected'; Expected = $false
           Actual = { Test-ChatTitle (New-Lines @(@{ Text = "$target$target"; X = 400; Y = 25 })) $window $target } }
        @{ Name = 'misread title rejected'; Expected = $false
           Actual = { Test-ChatTitle @([pscustomobject]@{ Text = $misread; X = 400; Y = 25 }) $window $target } }
        @{ Name = 'search box detected'; Expected = $true
           Actual = { (Get-PasteLocation (New-Lines @(@{ Text = $target; X = 80; Y = 25 })) $window $target).InSearchBox } }
        @{ Name = 'misread search text still detected'; Expected = $true
           Actual = { (Get-PasteLocation @([pscustomobject]@{ Text = $misread; X = 110; Y = 60 }) $window $target).InSearchBox } }
        @{ Name = 'chat title not taken for search box'; Expected = $false
           Actual = { (Get-PasteLocation @([pscustomobject]@{ Text = $target; X = 400; Y = 60 }) $window $target).InSearchBox } }
        @{ Name = 'session row not taken for search box'; Expected = $false
           Actual = { (Get-PasteLocation @([pscustomobject]@{ Text = $target; X = 150; Y = 120 }) $window $target).InSearchBox } }
        @{ Name = 'unrelated text not taken for search box'; Expected = $false
           Actual = { (Get-PasteLocation @([pscustomobject]@{ Text = $unrelated; X = 110; Y = 60 }) $window $target).InSearchBox } }
        @{ Name = 'text in chat input detected'; Expected = $true
           Actual = { (Get-PasteLocation (New-Lines @(@{ Text = $target; X = 400; Y = 600 })) $window $target).InChatInput } }
        @{ Name = 'line break refused before typing'; Expected = $true
           Actual = { try { Send-Text $window "a`nb"; $false } catch { $_.Exception.Message -match 'line break' } } }
    )
    $failed = 0
    foreach ($check in $checks) {
        $actual = & $check.Actual
        $pass = $actual -eq $check.Expected
        if (-not $pass) { $failed++ }
        "$(if ($pass) { 'PASS' } else { 'FAIL' })  $($check.Name)"
    }
    if ($failed) { exit 1 }
}

if ($SelfTest) { Invoke-SelfTest; return }

if ($Text -match '[\x00-\x1F]') { 'Text contains a line break or control character. Nothing was typed.'; exit 1 }

$idleDeadline = (Get-Date).AddSeconds(60)
while ([Win]::IdleMs() -lt 3000) {
    if ((Get-Date) -gt $idleDeadline) { 'Keyboard or mouse stayed active for 60 seconds. No input was sent.'; exit 1 }
    Start-Sleep -Milliseconds 250
}

$window = Find-WeChatWindow
if (-not $window) { 'No visible WeChat window. Open the main window (not hidden in the tray).'; exit 1 }
if ($window.Minimized) {
    [Win]::ShowWindow($window.Handle, 9) | Out-Null
    Start-Sleep -Milliseconds 500
    $window = Find-WeChatWindow
    if (-not $window -or $window.Minimized) { 'Could not restore the WeChat window. No input was sent.'; exit 1 }
}
[Win]::Combo($VK_MENU)   # Windows only lets a process take the foreground right after input
[Win]::SetForegroundWindow($window.Handle) | Out-Null
Start-Sleep -Milliseconds 400
Assert-Foreground $window

if (-not (Test-OpenChat $window)) {
    'File Transfer Assistant is not the open chat. Open it by hand, then run this again. No text was typed.'
    exit 1
}
'Precondition ok: File Transfer Assistant is open.'

if ($Mode -eq 'Navigate') {
    Assert-Foreground $window
    [Win]::Combo($VK_CONTROL, $VK_F); Start-Sleep -Milliseconds 500
    Send-Text $window $target
    Start-Sleep -Milliseconds 1000

    $location = Get-PasteLocation (Read-EditArea $window) $window $target
    "Typed name seen in search box: $($location.InSearchBox), in chat input: $($location.InChatInput)"
    if ($location.InChatInput -or -not $location.InSearchBox) {
        'Search was not confirmed, so Enter was not pressed. Check the chat input box and clear it if the name landed there.'
        exit 1
    }
    Assert-Foreground $window
    [Win]::Combo($VK_RETURN); Start-Sleep -Milliseconds 1000
    "Chat opened by search: " + (Test-OpenChat $window)
} else {
    Send-Text $window $Text
    Start-Sleep -Milliseconds 400
    $seen = Get-PasteLocation (Read-EditArea $window) $window ($Text -replace '\s', '')
    "Typed. OCR sees the text in the input box: $($seen.InChatInput). Check the input box yourself."
    if ($Mode -eq 'Send') {
        Assert-Foreground $window
        [Win]::Combo($VK_RETURN); Start-Sleep -Milliseconds 800
        $needle = $Text -replace '\s', ''
        $sent = @(Read-WindowLines $window | Where-Object {
            $_.Text.Contains($needle) -and $_.X -ge $window.ColumnWidth -and $_.Y -lt $window.Height * 0.8 }).Count -gt 0
        "Pressed Enter. OCR sees the message above the input box: $sent. Confirm it in File Transfer Assistant."
    }
}
