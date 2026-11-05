# The engine's view of the WeChat window: a long-running child that answers each line on stdin
# with one line of JSON on stdout. It can read the window, open a row in the session list and
# scroll the open chat. Those go to WeChat's main window as posted messages, which neither take
# focus nor move the cursor. There is no way to type or send from here. Images stay in memory, so
# nothing is written to disk. It uses only what ships with Windows.
# Keep this file ASCII: Windows PowerShell 5.1 misreads UTF-8 that has no BOM.
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class Win {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public static List<IntPtr> All() { var l = new List<IntPtr>(); EnumWindows((h, _) => { l.Add(h); return true; }, IntPtr.Zero); return l; }
  public static long IdleMs() {
    var info = new LASTINPUTINFO(); info.cbSize = (uint)Marshal.SizeOf(info); GetLastInputInfo(ref info);
    return unchecked((uint)Environment.TickCount - info.dwTime);
  }
}
'@
[Win]::SetProcessDPIAware() | Out-Null

$screen = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
$script:dpi = $screen.DpiX / 96
$screen.Dispose()

# WeChat's session list and header keep their size when the window is resized.
$script:column = [int](296 * $script:dpi)
$script:header = [int](80 * $script:dpi)

$WM_MOUSEMOVE = [uint32]0x0200
$WM_LBUTTONDOWN = [uint32]0x0201
$WM_LBUTTONUP = [uint32]0x0202
$WM_MOUSEWHEEL = [uint32]0x020A

$script:ocr = $null
$script:asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($operation, [type]$resultType) {
    $task = $script:asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.Wait(-1) | Out-Null
    $task.Result
}

function Text([int[]]$points) { -join ([char[]]$points) }

function Get-Ocr {
    if (-not $script:ocr) {
        $script:ocr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans-CN'))
        if (-not $script:ocr) { throw 'no-chinese-ocr' }
    }
    $script:ocr
}

# Enlarging helps, and contrast helps some text while hurting other text, so scans read both ways.
function Read-Lines([System.Drawing.Bitmap]$source, [int]$scale, [bool]$enhance) {
    $image = New-Object System.Drawing.Bitmap ($source.Width * $scale), ($source.Height * $scale)
    $memory = New-Object System.IO.MemoryStream
    try {
        $graphics = [System.Drawing.Graphics]::FromImage($image)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $attributes = New-Object System.Drawing.Imaging.ImageAttributes
        if ($enhance) {
            # Gray with doubled contrast.
            $third = 2 / 3
            $matrix = New-Object System.Drawing.Imaging.ColorMatrix
            foreach ($row in 0, 1, 2) {
                foreach ($column in 0, 1, 2) { $matrix."Matrix$row$column" = $third }
                $matrix."Matrix4$row" = -0.5
            }
            $attributes.SetColorMatrix($matrix)
        }
        $graphics.DrawImage($source, (New-Object System.Drawing.Rectangle 0, 0, $image.Width, $image.Height),
            0, 0, $source.Width, $source.Height, [System.Drawing.GraphicsUnit]::Pixel, $attributes)
        $attributes.Dispose()
        $graphics.Dispose()
        $image.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
        $memory.Position = 0

        $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($memory)
        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $result = Await ((Get-Ocr).RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        foreach ($line in $result.Lines) {
            # The engine spaces out Chinese characters and may return full-width symbols.
            $first = @($line.Words)[0].BoundingRect
            [pscustomobject]@{
                Text = ($line.Text -replace '\s', '').Normalize([Text.NormalizationForm]::FormKC)
                X = $first.X / $scale
                Y = $first.Y / $scale
            }
        }
    } finally {
        $memory.Dispose()
        $image.Dispose()
    }
}

# Rows with the "someone @ me" marker, and what could be each one's chat name: the line above the
# marker in the list's text column. The marker's first characters are often lost, so "@ me" is what
# counts, and where its line starts says nothing about that column. A false alarm only costs a
# look, while a miss loses the message.
function Select-MentionRows($lines) {
    $mark = Text 0x40, 0x6211
    $column = 125 * $script:dpi
    $rows = @()
    foreach ($marker in @($lines | Where-Object { $_.Text.Contains($mark) } | Sort-Object Y)) {
        if (@($rows | Where-Object { [math]::Abs($_.y - $marker.Y) -lt 30 * $script:dpi }).Count) { continue }
        $names = @($lines | Where-Object {
            $above = $marker.Y - $_.Y
            $above -gt 8 * $script:dpi -and $above -lt 40 * $script:dpi -and [math]::Abs($_.X - $column) -lt 15 * $script:dpi
        } | ForEach-Object { $_.Text } | Select-Object -Unique)
        $rows += @{ y = $marker.Y; names = @($names) }
    }
    $rows
}

function Find-Mentions([System.Drawing.Bitmap]$list, [int]$offsetY) {
    $lines = @(Read-Lines $list 3 $false) + @(Read-Lines $list 3 $true)
    # Written out so a single row stays a list once it's JSON.
    , @(Select-MentionRows $lines | ForEach-Object { @{ y = [int]($_.y + $offsetY); names = $_.names } })
}

# The reads a real list gave, where one read of the marker started well to the right of the column.
function Invoke-SelfTestRows {
    $d = $script:dpi
    $marker = '[' + (Text 0x6709, 0x4EBA, 0x40, 0x6211) + ']'
    $name = Text 0x6D4B, 0x8BD5
    $line = { param($text, $x, $y) [pscustomobject]@{ Text = $text; X = $x * $d; Y = $y * $d } }
    $lines = @(
        (& $line $name 125 275)                                  # The name
        (& $line '12:30' 255 276)                                # The time, on the same line
        (& $line (Text 0x40, 0x6211) 150 294)                    # The marker, with its start lost
        (& $line "$marker x" 125 298)                            # The marker, read in full
        (& $line (Text 0x4E0A, 0x4E00, 0x884C) 125 210)          # The row above's name
        (& $line (Text 0x4E0A, 0x4E00, 0x6761) 125 232)          # The row above's preview
    )
    @{ state = 'ok'; mentions = @(Select-MentionRows $lines | ForEach-Object { @{ y = [int]$_.y; names = $_.names } }) }
}

# A minimized window reports a tiny placeholder size and can't be captured, so it's only returned,
# marked as minimized, when no normal window is available.
function Find-WeChatWindow {
    $owners = @(Get-Process Weixin -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    $best = $null; $bestArea = 0; $minimized = $null
    foreach ($handle in [Win]::All()) {
        $owner = [uint32]0
        [Win]::GetWindowThreadProcessId($handle, [ref]$owner) | Out-Null
        if ($owners -notcontains [int]$owner -or -not [Win]::IsWindowVisible($handle)) { continue }
        $rect = New-Object Win+RECT
        [Win]::GetWindowRect($handle, [ref]$rect) | Out-Null
        $width = $rect.Right - $rect.Left; $height = $rect.Bottom - $rect.Top
        $found = [pscustomobject]@{ Handle = $handle; Left = $rect.Left; Top = $rect.Top; Width = $width; Height = $height; Minimized = [Win]::IsIconic($handle) }
        if ($found.Minimized) { $minimized = $found; continue }
        if ($width -lt 500 -or $height -lt 400) { continue }
        if ($width * $height -gt $bestArea) { $best = $found; $bestArea = $width * $height }
    }
    if ($best) { $best } else { $minimized }
}

function Test-Blank([System.Drawing.Bitmap]$image) {
    $samples = 0; $dark = 0
    for ($x = 0; $x -lt $image.Width; $x += [math]::Max(1, [int]($image.Width / 60))) {
        for ($y = 0; $y -lt $image.Height; $y += [math]::Max(1, [int]($image.Height / 40))) {
            $samples++
            if ($image.GetPixel($x, $y).GetBrightness() -lt 0.02) { $dark++ }
        }
    }
    $dark / $samples -gt 0.95
}

# Null when the window can't be captured. The caller disposes what it gets.
function Get-WindowImage($window) {
    $image = New-Object System.Drawing.Bitmap $window.Width, $window.Height
    $graphics = [System.Drawing.Graphics]::FromImage($image)
    $hdc = $graphics.GetHdc()
    $printed = [Win]::PrintWindow($window.Handle, $hdc, 2)   # PW_RENDERFULLCONTENT
    $graphics.ReleaseHdc($hdc)
    $graphics.Dispose()
    if ($printed -and -not (Test-Blank $image)) { return $image }
    $image.Dispose()
    $null
}

function Test-Foreground($window) { [Win]::GetForegroundWindow() -eq $window.Handle }

function Invoke-Scan {
    $window = Find-WeChatWindow
    if (-not $window) { return @{ state = 'missing' } }
    if ($window.Minimized) { return @{ state = 'minimized' } }
    $image = Get-WindowImage $window
    if (-not $image) { return @{ state = 'blank' } }
    try {
        # Only the session list: the open chat's text has no reason to be read here.
        $area = New-Object System.Drawing.Rectangle 0, $script:header, ([math]::Min($script:column, $window.Width)), ($window.Height - $script:header)
        $list = $image.Clone($area, $image.PixelFormat)
        try {
            return @{
                state = 'ok'
                mentions = (Find-Mentions $list $script:header)
                foreground = (Test-Foreground $window)
                idleMs = [Win]::IdleMs()
            }
        } finally { $list.Dispose() }
    } finally { $image.Dispose() }
}

# No single OCR setting is reliable on a title: one real title was a character off at 3x and
# above, and exact with contrast at 1x and 2x. Whoever uses this wants an exact match in any read.
function Get-Titles([System.Drawing.Bitmap]$image) {
    $area = New-Object System.Drawing.Rectangle $script:column, 0, ($image.Width - $script:column), $script:header
    $title = $image.Clone($area, $image.PixelFormat)
    try {
        $lines = @(Read-Lines $title 3 $false) + @(Read-Lines $title 3 $true) + @(Read-Lines $title 2 $true) + @(Read-Lines $title 1 $true)
        , @($lines | ForEach-Object { $_.Text } | Select-Object -Unique)
    } finally { $title.Dispose() }
}

# Where the message area ends and the input box begins, so an unsent draft isn't sent to anyone.
# That left margin has no text in it, so the first change of colour going up is their border.
function Find-InputTop([System.Drawing.Bitmap]$image) {
    $x = $script:column + [int](5 * $script:dpi)
    $start = $image.Height - [int](10 * $script:dpi)
    $base = $image.GetPixel($x, $start)
    for ($y = $start; $y -gt $image.Height * 0.45; $y--) {
        $pixel = $image.GetPixel($x, $y)
        if ([math]::Abs($pixel.R - $base.R) + [math]::Abs($pixel.G - $base.G) + [math]::Abs($pixel.B - $base.B) -gt 3) { return $y + 1 }
    }
    $image.Height
}

# The open chat only. The session list shows other chats' names and messages, so it stays here.
function Get-ChatArea([System.Drawing.Bitmap]$image) {
    $area = New-Object System.Drawing.Rectangle $script:column, 0, ($image.Width - $script:column), (Find-InputTop $image)
    $image.Clone($area, $image.PixelFormat)
}

function Get-ChangedPercent([System.Drawing.Bitmap]$first, [System.Drawing.Bitmap]$second) {
    if ($first.Height -ne $second.Height) { return 100 }
    $samples = 0; $changed = 0
    for ($x = 0; $x -lt $first.Width; $x += [math]::Max(1, [int]($first.Width / 80))) {
        for ($y = $script:header; $y -lt $first.Height; $y += [math]::Max(1, [int]($first.Height / 60))) {
            $samples++
            if ($first.GetPixel($x, $y).ToArgb() -ne $second.GetPixel($x, $y).ToArgb()) { $changed++ }
        }
    }
    if ($samples) { 100 * $changed / $samples } else { 0 }
}

function Get-Point([int]$x, [int]$y) { [IntPtr](($x -band 0xFFFF) -bor (($y -band 0xFFFF) -shl 16)) }

function Invoke-OpenRow([int]$y) {
    $window = Find-WeChatWindow
    if (-not $window) { return @{ state = 'missing' } }
    if ($window.Minimized) { return @{ state = 'minimized' } }
    if ($y -lt $script:header -or $y -ge $window.Height) { throw "row is outside the session list: $y" }

    $position = Get-Point ([int]($script:column / 2)) $y
    [Win]::PostMessage($window.Handle, $WM_MOUSEMOVE, [IntPtr]::Zero, $position) | Out-Null
    Start-Sleep -Milliseconds 60
    [Win]::PostMessage($window.Handle, $WM_LBUTTONDOWN, [IntPtr]1, $position) | Out-Null
    Start-Sleep -Milliseconds 60
    [Win]::PostMessage($window.Handle, $WM_LBUTTONUP, [IntPtr]::Zero, $position) | Out-Null
    Start-Sleep -Milliseconds 1200

    $image = Get-WindowImage $window
    if (-not $image) { return @{ state = 'blank' } }
    try {
        @{ state = 'ok'; titles = (Get-Titles $image) }
    } finally { $image.Dispose() }
}

# WeChat moves about the same distance per wheel message whatever its delta says, so scrolling
# further takes more messages. The distance varies when they come quickly, which is why pages
# need generous overlap and can't be lined up by arithmetic.
function Send-Wheel($window, [int]$direction, [int]$count, [int]$gapMs) {
    $position = Get-Point ($window.Left + $script:column + [int](($window.Width - $script:column) / 2)) ($window.Top + [int]($window.Height * 0.45))
    # The delta is signed, in the high word.
    $delta = [int64]($direction * 120) -band 0xFFFF
    for ($post = 0; $post -lt $count; $post++) {
        [Win]::PostMessage($window.Handle, $WM_MOUSEWHEEL, [IntPtr]([int64]($delta -shl 16)), $position) | Out-Null
        Start-Sleep -Milliseconds $gapMs
    }
}

# WeChat can be left in front with nobody there, so being in front isn't enough to count as in use.
# Posted messages don't count as input, so this only ever reacts to the owner.
function Test-OwnerActive($window) { (Test-Foreground $window) -and [Win]::IdleMs() -lt 5000 }

# Newest page first. Each page carries the titles read from that same capture, so the engine can
# tell that this image, and not just the chat a moment ago, is the right one. Gives way as soon as
# the owner comes back to WeChat, leaving the chat wherever it is.
function Invoke-CaptureChat([int]$pages, [int]$postsPerPage) {
    $window = Find-WeChatWindow
    if (-not $window) { return @{ state = 'missing' } }
    if ($window.Minimized) { return @{ state = 'minimized' } }

    $shots = @()
    $previous = $null
    $reachedTop = $false
    $interrupted = $false
    $scrolled = 0
    try {
        for ($page = 0; $page -lt $pages; $page++) {
            if (Test-OwnerActive $window) { $interrupted = $true; break }
            $image = Get-WindowImage $window
            if (-not $image) { break }
            try {
                $chat = Get-ChatArea $image
                if ($previous -and (Get-ChangedPercent $previous $chat) -lt 0.5) {
                    $reachedTop = $true
                    $chat.Dispose()
                    break
                }
                $memory = New-Object System.IO.MemoryStream
                try {
                    $chat.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
                    $shots += @{ image = [Convert]::ToBase64String($memory.ToArray()); titles = (Get-Titles $image) }
                } finally { $memory.Dispose() }
                if ($previous) { $previous.Dispose() }
                $previous = $chat
            } finally { $image.Dispose() }
            if ($page -lt $pages - 1) {
                Send-Wheel $window 1 $postsPerPage 40
                $scrolled += $postsPerPage
                Start-Sleep -Milliseconds 600
            }
        }
    } finally {
        if ($previous) { $previous.Dispose() }
    }
    # Twice as far as it came, since it stops at the bottom and the distance isn't exact.
    if ($scrolled -and -not $interrupted) { Send-Wheel $window -1 ($scrolled * 2) 20 }
    @{ state = 'ok'; pages = @($shots); reachedTop = $reachedTop; interrupted = $interrupted }
}

# Runs the reading code on a generated list, so a test can check it without a real WeChat.
function Invoke-SelfTest {
    $marker = '[' + (Text 0x6709, 0x4EBA, 0x40, 0x6211) + ']'
    $chats = @(
        @{ Name = Text 0x9879, 0x76EE, 0x5468, 0x4F1A, 0x7FA4; Preview = "$marker " + (Text 0x4ECA, 0x5929, 0x5F00, 0x4F1A) }
        @{ Name = Text 0x8D22, 0x52A1, 0x62A5, 0x9500, 0x7FA4; Preview = Text 0x4ECA, 0x5929, 0x5F00, 0x4F1A }
        @{ Name = Text 0x5E02, 0x573A, 0x63A8, 0x5E7F, 0x7FA4; Preview = "$marker " + (Text 0x4ECA, 0x5929, 0x5F00, 0x4F1A) }
    )
    $width = [int](296 * $script:dpi)
    $image = New-Object System.Drawing.Bitmap $width, ([int](400 * $script:dpi))
    $graphics = [System.Drawing.Graphics]::FromImage($image)
    $graphics.Clear([System.Drawing.Color]::White)
    $nameFont = New-Object System.Drawing.Font 'Microsoft YaHei', (14 * $script:dpi), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
    $previewFont = New-Object System.Drawing.Font 'Microsoft YaHei', (12 * $script:dpi), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
    $row = 0
    foreach ($chat in $chats) {
        $x = 125 * $script:dpi
        $y = (12 + 66 * $row) * $script:dpi
        $graphics.DrawString($chat.Name, $nameFont, [System.Drawing.Brushes]::Black, $x, $y)
        $graphics.DrawString($chat.Preview, $previewFont, [System.Drawing.Brushes]::Gray, $x, $y + 22 * $script:dpi)
        $row++
    }
    $graphics.Dispose()
    try {
        @{ state = 'ok'; mentions = (Find-Mentions $image 0) }
    } finally { $image.Dispose() }
}

# Runs the cropping code on a generated window: a dark list, a title, a message area and an input box.
function Invoke-SelfTestChat {
    $width = $script:column + 700
    $height = 600
    $inputTop = $height - 150
    $image = New-Object System.Drawing.Bitmap $width, $height
    $graphics = [System.Drawing.Graphics]::FromImage($image)
    $graphics.Clear([System.Drawing.Color]::FromArgb(237, 237, 237))
    $list = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(120, 0, 0))
    $box = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(250, 250, 250))
    $graphics.FillRectangle($list, 0, 0, $script:column, $height)
    $graphics.FillRectangle($box, $script:column, $inputTop, 700, 150)
    $font = New-Object System.Drawing.Font 'Microsoft YaHei', (15 * $script:dpi), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
    $title = (Text 0x9879, 0x76EE, 0x5468, 0x4F1A, 0x7FA4) + '(3)'
    $graphics.DrawString($title, $font, [System.Drawing.Brushes]::Black, $script:column + 15 * $script:dpi, 45 * $script:dpi)
    $graphics.Dispose()
    try {
        $chat = Get-ChatArea $image
        try {
            $listVisible = $false
            for ($y = 0; $y -lt $chat.Height; $y += 10) {
                if ($chat.GetPixel(0, $y).ToArgb() -eq $list.Color.ToArgb()) { $listVisible = $true }
            }
            @{
                state = 'ok'
                width = $chat.Width
                expectedWidth = 700
                height = $chat.Height
                expectedHeight = $inputTop
                listVisible = $listVisible
                titles = (Get-Titles $image)
            }
        } finally { $chat.Dispose() }
    } finally { $image.Dispose() }
}

# Plain ASCII on stdout, so the console's code page can't garble a chat's name.
function Write-Reply($reply) {
    $json = ConvertTo-Json $reply -Compress -Depth 5
    $ascii = [regex]::Replace($json, '[^\x00-\x7F]', { param($match) '\u{0:x4}' -f [int][char]$match.Value })
    [Console]::Out.WriteLine($ascii)
    [Console]::Out.Flush()
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }   # The engine has gone.
    $id = $null
    try {
        $request = ConvertFrom-Json $line
        $id = $request.id
        $reply = switch ($request.command) {
            'scan' { Invoke-Scan }
            'openRow' { Invoke-OpenRow $request.y }
            'captureChat' { Invoke-CaptureChat $request.pages $request.postsPerPage }
            'selftest' { Invoke-SelfTest }
            'selftestRows' { Invoke-SelfTestRows }
            'selftestChat' { Invoke-SelfTestChat }
            default { throw "unknown command: $($request.command)" }
        }
        $reply.id = $id
        Write-Reply $reply
    } catch {
        Write-Reply @{ id = $id; error = "$($_.Exception.Message)" }
    }
}
