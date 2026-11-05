# What the scripts that work with the WeChat window share: finding it, capturing it, reading text
# from it. Nothing here can type. Images stay in memory, so nothing is written to disk. It uses only
# what ships with Windows.
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
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; public POINT(int x, int y) { X = x; Y = y; } }
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public static List<IntPtr> All() { var l = new List<IntPtr>(); EnumWindows((h, _) => { l.Add(h); return true; }, IntPtr.Zero); return l; }
  public static IntPtr RootAt(int x, int y) { return GetAncestor(WindowFromPoint(new POINT(x, y)), 2); }
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

# Enlarging helps, and contrast helps some text while hurting other text, so callers read both ways.
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

# The input box's inside, from its top to just above its bottom edge. It's a rounded card above the
# window's drop shadow, and this margin of it has no text or icons in it, so going up from the bottom
# it's the first long stretch of one colour. Null if that stretch has no top edge to find.
function Find-InputBox([System.Drawing.Bitmap]$image) {
    $x = $script:column + [int](10 * $script:dpi)
    $limit = [int]($image.Height * 0.25)
    $bottom = $image.Height
    $color = $image.GetPixel($x, $image.Height - 1).ToArgb()
    for ($y = $image.Height - 2; $y -ge $limit; $y--) {
        $argb = $image.GetPixel($x, $y).ToArgb()
        if ($argb -ne $color) {
            if ($bottom - ($y + 1) -ge 50 * $script:dpi) { return [pscustomobject]@{ Top = $y + 1; Bottom = $bottom } }
            $bottom = $y + 1
            $color = $argb
        }
    }
    $null
}

# Where the message area ends.
function Find-InputTop([System.Drawing.Bitmap]$image) {
    $box = Find-InputBox $image
    if ($box) { $box.Top } else { $image.Height }
}

function Get-Point([int]$x, [int]$y) { [IntPtr](($x -band 0xFFFF) -bor (($y -band 0xFFFF) -shl 16)) }

# Posted, so it neither takes focus nor moves the cursor. The position is relative to the window.
function Send-Click($window, [int]$x, [int]$y) {
    $position = Get-Point $x $y
    [Win]::PostMessage($window.Handle, $WM_MOUSEMOVE, [IntPtr]::Zero, $position) | Out-Null
    Start-Sleep -Milliseconds 60
    [Win]::PostMessage($window.Handle, $WM_LBUTTONDOWN, [IntPtr]1, $position) | Out-Null
    Start-Sleep -Milliseconds 60
    [Win]::PostMessage($window.Handle, $WM_LBUTTONUP, [IntPtr]::Zero, $position) | Out-Null
}

# Plain ASCII on stdout, so the console's code page can't garble a chat's name.
function Write-Reply($reply) {
    $json = ConvertTo-Json $reply -Compress -Depth 5
    $ascii = [regex]::Replace($json, '[^\x00-\x7F]', { param($match) '\u{0:x4}' -f [int][char]$match.Value })
    [Console]::Out.WriteLine($ascii)
    [Console]::Out.Flush()
}
