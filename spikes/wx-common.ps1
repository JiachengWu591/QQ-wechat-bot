# Shared by the WeChat spikes: window helpers and the OCR engine built into Windows.
# Chinese text is written as code points because Windows PowerShell 5.1 misreads
# UTF-8 scripts that have no BOM.
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class Win {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; public POINT(int x, int y) { X = x; Y = y; } }
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  public static IntPtr RootAt(int x, int y) { return GetAncestor(WindowFromPoint(new POINT(x, y)), 2); }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [StructLayout(LayoutKind.Explicit, Size = 40)] struct INPUT {
    [FieldOffset(0)] public uint type; [FieldOffset(8)] public ushort vk; [FieldOffset(10)] public ushort scan;
    [FieldOffset(12)] public uint flags; [FieldOffset(16)] public uint time; [FieldOffset(24)] public IntPtr extra;
  }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  // KEYEVENTF_UNICODE delivers the character itself, so neither the clipboard nor the IME is involved.
  public static bool TypeChar(char c) {
    var down = new INPUT { type = 1, scan = c, flags = 4 };
    var up = new INPUT { type = 1, scan = c, flags = 4 | 2 };
    return SendInput(2, new[] { down, up }, Marshal.SizeOf(typeof(INPUT))) == 2;
  }
  public static List<IntPtr> All() { var l = new List<IntPtr>(); EnumWindows((h, _) => { l.Add(h); return true; }, IntPtr.Zero); return l; }
  public static long IdleMs() {
    var info = new LASTINPUTINFO(); info.cbSize = (uint)Marshal.SizeOf(info); GetLastInputInfo(ref info);
    return unchecked((uint)Environment.TickCount - info.dwTime);
  }
  public static void Combo(params byte[] keys) {
    foreach (var k in keys) keybd_event(k, 0, 0, UIntPtr.Zero);
    Array.Reverse(keys);
    foreach (var k in keys) keybd_event(k, 0, 2, UIntPtr.Zero);
  }
}
'@
[Win]::SetProcessDPIAware() | Out-Null

# WeChat's left panes and header keep a fixed size when the window is resized: the chat
# title stayed at x=382 at both 1191 and 976 wide, at 125% display scale.
$screen = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
$script:dpiScale = $screen.DpiX / 96
$screen.Dispose()

$script:asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($operation, [type]$resultType) {
    $task = $script:asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.Wait(-1) | Out-Null
    $task.Result
}

function ConvertFrom-CodePoints([int[]]$points) { -join ([char[]]$points) }

# Enlarging first matters: on generated UI text, exact reads went from 22/56 at 1x
# to 43/56 at 3x. Text under 16px stays unreliable, so never treat a read as certain.
function Read-OcrLines([string]$path, [int]$Scale = 3, [bool]$Enhance = $true) {
    $scaledPath = "$path.scaled.png"
    $source = [System.Drawing.Image]::FromFile($path)
    try {
        $image = New-Object System.Drawing.Bitmap ($source.Width * $Scale), ($source.Height * $Scale)
        $graphics = [System.Drawing.Graphics]::FromImage($image)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $attributes = New-Object System.Drawing.Imaging.ImageAttributes
        if ($Enhance) {
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
        $graphics.Dispose(); $image.Save($scaledPath, [System.Drawing.Imaging.ImageFormat]::Png); $image.Dispose()
    } finally { $source.Dispose() }

    try {
        $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($scaledPath)) ([Windows.Storage.StorageFile])
        $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        try {
            $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
            $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans-CN'))
            if (-not $engine) { throw 'Chinese OCR is not available on this machine.' }
            $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
            foreach ($line in $result.Lines) {
                # The engine spaces out Chinese characters and may return full-width symbols.
                $first = @($line.Words)[0].BoundingRect
                [pscustomobject]@{
                    Text = ($line.Text -replace '\s', '').Normalize([Text.NormalizationForm]::FormKC)
                    X = $first.X / $Scale; Y = $first.Y / $Scale
                }
            }
        } finally { $stream.Dispose() }
    } finally { Remove-Item $scaledPath -ErrorAction SilentlyContinue }
}

# Neither read wins everywhere: contrast fixed the real WeChat title (two wrong
# characters without it) but broke generated black-on-white text. Both reads count.
function Read-OcrAll([string]$path) {
    @(Read-OcrLines $path) + @(Read-OcrLines $path -Enhance $false)
}

# A minimized window reports a tiny placeholder size and can't be captured, so it is
# only returned, marked as minimized, when no normal window is available.
function Find-WeChatWindow {
    $pids = @(Get-Process Weixin -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    $best = $null; $bestArea = 0; $minimized = $null
    foreach ($handle in [Win]::All()) {
        $owner = [uint32]0
        [Win]::GetWindowThreadProcessId($handle, [ref]$owner) | Out-Null
        if ($pids -notcontains [int]$owner -or -not [Win]::IsWindowVisible($handle)) { continue }
        $rect = New-Object Win+RECT
        [Win]::GetWindowRect($handle, [ref]$rect) | Out-Null
        $width = $rect.Right - $rect.Left; $height = $rect.Bottom - $rect.Top
        $className = New-Object System.Text.StringBuilder 256
        [Win]::GetClassName($handle, $className, 256) | Out-Null
        $found = [pscustomobject]@{
            Handle = $handle; ClassName = "$className"; Left = $rect.Left; Top = $rect.Top; Width = $width; Height = $height
            Minimized = [Win]::IsIconic($handle)
            ColumnWidth = [int](296 * $script:dpiScale); HeaderHeight = [int](80 * $script:dpiScale)
        }
        if ($found.Minimized) { $minimized = $found; continue }
        if ($width -lt 500 -or $height -lt 400) { continue }
        if ($width * $height -gt $bestArea) { $best = $found; $bestArea = $width * $height }
    }
    if ($best) { $best } else { $minimized }
}

function Save-WindowImage($window, [string]$path) {
    $image = New-Object System.Drawing.Bitmap $window.Width, $window.Height
    $graphics = [System.Drawing.Graphics]::FromImage($image)
    $hdc = $graphics.GetHdc()
    $ok = [Win]::PrintWindow($window.Handle, $hdc, 2)   # PW_RENDERFULLCONTENT
    $graphics.ReleaseHdc($hdc); $graphics.Dispose()
    $samples = 0; $dark = 0
    for ($x = 0; $x -lt $window.Width; $x += [math]::Max(1, [int]($window.Width / 60))) {
        for ($y = 0; $y -lt $window.Height; $y += [math]::Max(1, [int]($window.Height / 40))) {
            $samples++; if ($image.GetPixel($x, $y).GetBrightness() -lt 0.02) { $dark++ }
        }
    }
    $image.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $image.Dispose()
    [pscustomobject]@{ PrintWindowOk = $ok; DarkPercent = [math]::Round(100 * $dark / $samples) }
}

# Scanning for mentions tolerates misreads ("[someone @me]" often loses its first
# character). A false alarm only costs a look, while a miss loses the message.
function Test-MentionMarker([string]$text) { $text.Contains('@' + [char]0x6211) }

# Only the open chat, so other chats' names and previews in the session list stay local.
function Save-ChatArea([string]$path, $window, [string]$outPath) {
    $width = $window.Width - $window.ColumnWidth
    $source = [System.Drawing.Image]::FromFile($path)
    try {
        $crop = New-Object System.Drawing.Bitmap $width, $window.Height
        $graphics = [System.Drawing.Graphics]::FromImage($crop)
        $graphics.DrawImage($source, (New-Object System.Drawing.Rectangle 0, 0, $width, $window.Height),
            (New-Object System.Drawing.Rectangle $window.ColumnWidth, 0, $width, $window.Height), [System.Drawing.GraphicsUnit]::Pixel)
        $graphics.Dispose(); $crop.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png); $crop.Dispose()
    } finally { $source.Dispose() }
}

function Read-RegionLines([string]$path, [int]$left, [int]$top, [int]$width, [int]$height, [int[]]$ExtraContrastScales = @()) {
    $cropPath = "$path.region.png"
    $source = [System.Drawing.Image]::FromFile($path)
    try {
        $crop = New-Object System.Drawing.Bitmap $width, $height
        $graphics = [System.Drawing.Graphics]::FromImage($crop)
        $graphics.DrawImage($source, (New-Object System.Drawing.Rectangle 0, 0, $width, $height),
            (New-Object System.Drawing.Rectangle $left, $top, $width, $height), [System.Drawing.GraphicsUnit]::Pixel)
        $graphics.Dispose(); $crop.Save($cropPath, [System.Drawing.Imaging.ImageFormat]::Png); $crop.Dispose()
    } finally { $source.Dispose() }
    try {
        @(Read-OcrAll $cropPath) + @($ExtraContrastScales | ForEach-Object { Read-OcrLines $cropPath -Scale $_ }) | ForEach-Object { $_.X += $left; $_.Y += $top; $_ }
    } finally { Remove-Item $cropPath -ErrorAction SilentlyContinue }
}

# Whole-window OCR skipped the header on real WeChat while a crop of it still gave
# results, so the title gets its own read. No single setting is reliable: on 2026-11-05 the real
# title was one character off at 3x and above, and exact with contrast at 1x and 2x.
function Read-HeaderLines([string]$path, $window) {
    Read-RegionLines $path $window.ColumnWidth 0 ($window.Width - $window.ColumnWidth) $window.HeaderHeight -ExtraContrastScales 1, 2
}

# Whole-window OCR also missed text typed into the input box, so the two places typed
# text can land get the same treatment. The search crop stops above the first session
# row and left of the chat title, so neither can pass for a filled search box.
function Read-EditAreaLines([string]$path, $window) {
    $inputTop = [int]($window.Height * 0.75)
    @(Read-RegionLines $path 0 0 $window.ColumnWidth $window.HeaderHeight) +
    @(Read-RegionLines $path $window.ColumnWidth $inputTop ($window.Width - $window.ColumnWidth) ($window.Height - $inputTop))
}

function Get-EditDistance([string]$a, [string]$b) {
    $previous = @(0..$b.Length)
    for ($i = 1; $i -le $a.Length; $i++) {
        $current = @($i)
        for ($j = 1; $j -le $b.Length; $j++) {
            $cost = if ($a[$i - 1] -ceq $b[$j - 1]) { 0 } else { 1 }
            $insert = $current[$j - 1] + 1
            $delete = $previous[$j] + 1
            $replace = $previous[$j - 1] + $cost
            $current += [math]::Min([math]::Min($insert, $delete), $replace)
        }
        $previous = $current
    }
    $previous[$b.Length]
}

# The open chat's name sits above the chat area, right of the session list. This
# guards what gets sent where, so it is deliberately exact: a misread stops the run.
function Test-ChatTitle($lines, $window, [string]$title) {
    @($lines | Where-Object {
        $_.Text -ceq $title -and $_.X -ge $window.ColumnWidth -and $_.Y -lt $window.HeaderHeight }).Count -gt 0
}

# Text landing in the chat input means Enter would send it to the open chat. Typed text
# in the search box read back 2 or 3 characters off on real WeChat, so up to half may
# differ: this only tells which box the text we just typed is in. The exact title check
# still decides where anything gets sent.
function Get-PasteLocation($lines, $window, [string]$text) {
    $hits = @($lines | Where-Object { (Get-EditDistance $_.Text $text) -le [math]::Floor($text.Length / 2) })
    [pscustomobject]@{
        InSearchBox = @($hits | Where-Object { $_.X -lt $window.ColumnWidth -and $_.Y -lt $window.HeaderHeight }).Count -gt 0
        InChatInput = @($hits | Where-Object { $_.X -ge $window.ColumnWidth -and $_.Y -gt $window.Height * 0.7 }).Count -gt 0
    }
}
