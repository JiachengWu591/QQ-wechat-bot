# Checks reading WeChat from the screen, using only what ships with Windows.
# It never touches WeChat's process memory or database, sends no input, and
# prints no chat text.
#   powershell -File 05-wx-screen.ps1 -Check     OCR self-test, plus whether a WeChat window exists
#   powershell -File 05-wx-screen.ps1 -Capture   capture the WeChat window, report counts only
#   add -Restore to show a minimized window briefly, without taking focus, then minimize it again
#   add -Keep to keep output\wx-window.png for inspection (it may show private chats)
param([switch]$Check, [switch]$Capture, [switch]$Restore, [switch]$Keep)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'wx-common.ps1')

$mentionMarker = ConvertFrom-CodePoints 0x6709, 0x4EBA, 0x40, 0x6211              # someone @ me
$fileTransfer = ConvertFrom-CodePoints 0x6587, 0x4EF6, 0x4F20, 0x8F93, 0x52A9, 0x624B   # File Transfer Assistant
$searchLabel = ConvertFrom-CodePoints 0x641C, 0x7D22                                  # Search
$outputDir = Join-Path $PSScriptRoot 'output'
New-Item -ItemType Directory -Force $outputDir | Out-Null

if ($Check) {
    'OCR languages: ' + (([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }) -join ', ')
    $path = Join-Path $outputDir 'ocr-selftest.png'
    $image = New-Object System.Drawing.Bitmap 420, 80
    $graphics = [System.Drawing.Graphics]::FromImage($image)
    $graphics.Clear([System.Drawing.Color]::White)
    $font = New-Object System.Drawing.Font 'Microsoft YaHei', 20, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
    $graphics.DrawString("[$mentionMarker]", $font, [System.Drawing.Brushes]::Black, 10, 20)
    $graphics.Dispose(); $image.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $image.Dispose()
    $started = Get-Date
    $lines = @(Read-OcrLines $path)
    "Self-test lines: $($lines.Count), marker found: " + (@($lines | Where-Object { Test-MentionMarker $_.Text }).Count -gt 0) + ", OCR ms: " + [int]((Get-Date) - $started).TotalMilliseconds
    Remove-Item $path
    $screen = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
    "Display scale: $([int]($screen.DpiX / 96 * 100))%"
    $screen.Dispose()
    $window = Find-WeChatWindow
    if (-not $window) { 'WeChat window: none visible (not running, or hidden in the tray)' }
    elseif ($window.Minimized) { 'WeChat window: minimized, so it cannot be captured until restored' }
    else { "WeChat window: class $($window.ClassName), size $($window.Width)x$($window.Height)" }
}

if ($Capture) {
    $window = Find-WeChatWindow
    if (-not $window) { 'WeChat has no visible window. Open it from the tray first.'; exit 1 }
    $minimizedHandle = $null
    if ($window.Minimized) {
        if (-not $Restore) { 'WeChat is minimized. Restore it, or pass -Restore to show it briefly without taking focus.'; exit 1 }
        $minimizedHandle = $window.Handle
        [Win]::ShowWindow($minimizedHandle, 4) | Out-Null   # SW_SHOWNOACTIVATE
        Start-Sleep -Milliseconds 800
        $window = Find-WeChatWindow
    }
    try {
        if (-not $window -or $window.Minimized) { 'Could not show the WeChat window.'; exit 1 }
        "Window class: $($window.ClassName), size: $($window.Width)x$($window.Height), foreground: $([Win]::GetForegroundWindow() -eq $window.Handle), restored for capture: $([bool]$minimizedHandle)"

        $path = Join-Path $outputDir 'wx-window.png'
        $stats = Save-WindowImage $window $path
        "PrintWindow returned: $($stats.PrintWindowOk), black pixels: $($stats.DarkPercent)% (near 100% means capture failed)"

        $started = Get-Date
        $lines = @(Read-OcrLines $path)
        "OCR ms: " + [int]((Get-Date) - $started).TotalMilliseconds
        $leftCount = @($lines | Where-Object { $_.X -lt $window.ColumnWidth }).Count
        $headerCount = @($lines | Where-Object { $_.X -ge $window.ColumnWidth -and $_.Y -lt $window.HeaderHeight }).Count
        "OCR lines: $($lines.Count), session list side: $leftCount, chat side: $($lines.Count - $leftCount), chat header: $headerCount"
        # The search box label is fixed UI text, so it gives a known answer to check against.
        "Search box label read correctly: " + (@($lines | Where-Object { $_.Text.Contains($searchLabel) -and $_.X -lt $window.ColumnWidth -and $_.Y -lt $window.HeaderHeight }).Count -gt 0)
        "Mention markers: " + @(Read-OcrAll $path | Where-Object { Test-MentionMarker $_.Text }).Count
        $header = @(Read-HeaderLines $path $window)
        "Chat header crop: lines $($header.Count), characters " + (($header | ForEach-Object { $_.Text.Length }) | Measure-Object -Sum).Sum
        "Open chat is File Transfer Assistant: " + (Test-ChatTitle $header $window $fileTransfer)
        if ($Keep) {
            $textPath = Join-Path $outputDir 'wx-ocr.txt'
            @($header + $lines) | ForEach-Object { $_.Text } | Out-File -FilePath $textPath -Encoding utf8
            Save-ChatArea $path $window (Join-Path $outputDir 'wx-chat.png')
            "Kept $path, $textPath and wx-chat.png. Compare them to judge OCR quality. They may show private chats."
        } else { Remove-Item $path }
    } finally {
        if ($minimizedHandle) { [Win]::ShowWindow($minimizedHandle, 7) | Out-Null }   # SW_SHOWMINNOACTIVE
    }
}
