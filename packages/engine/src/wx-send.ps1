# Types a reply the owner has approved into a WeChat group and sends it. It runs once per approval,
# which is the only time anything here can type: the long-running helper has no way to. It stops
# rather than guess, because a message sent to the wrong chat can't be taken back. Every check it
# fails before pressing Enter means nothing was sent.
# Reads one request from stdin and writes one line of JSON to stdout.
# Keep this file ASCII: Windows PowerShell 5.1 misreads UTF-8 that has no BOM.
. (Join-Path $PSScriptRoot 'wx-common.ps1')

Add-Type @'
using System; using System.Runtime.InteropServices;
public static class Keys {
  [StructLayout(LayoutKind.Explicit, Size = 40)] struct INPUT {
    [FieldOffset(0)] public uint type; [FieldOffset(8)] public ushort vk; [FieldOffset(10)] public ushort scan;
    [FieldOffset(12)] public uint flags; [FieldOffset(16)] public uint time; [FieldOffset(24)] public IntPtr extra;
  }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  // KEYEVENTF_UNICODE delivers the character itself, so neither the clipboard nor the IME is involved.
  public static bool TypeChar(char c) {
    var down = new INPUT { type = 1, scan = c, flags = 4 };
    var up = new INPUT { type = 1, scan = c, flags = 4 | 2 };
    return SendInput(2, new[] { down, up }, Marshal.SizeOf(typeof(INPUT))) == 2;
  }
  public static void Combo(params byte[] keys) {
    foreach (var k in keys) keybd_event(k, 0, 0, UIntPtr.Zero);
    Array.Reverse(keys);
    foreach (var k in keys) keybd_event(k, 0, 2, UIntPtr.Zero);
  }
}
'@

$VK_BACK = [byte]0x08; $VK_RETURN = [byte]0x0D; $VK_CONTROL = [byte]0x11; $VK_MENU = [byte]0x12; $VK_ESCAPE = [byte]0x1B
$VK_A = [byte]0x41; $VK_F = [byte]0x46
$IDLE_NEEDED_MS = 3000
$IDLE_WAIT_SECONDS = 30

function Stop-Send([string]$reason) { throw "stop:$reason" }

function Assert-Foreground($window) {
    if (-not (Test-Foreground $window)) { Stop-Send 'lost-focus' }
}

function Send-Text($window, [string]$value) {
    foreach ($character in $value.ToCharArray()) {
        Assert-Foreground $window
        if (-not [Keys]::TypeChar($character)) { Stop-Send 'input-rejected' }
        Start-Sleep -Milliseconds 30
    }
}

# Exact only, since this decides where a message goes. The header can show a member count after the
# name. OCR has already folded full-width brackets by the time text gets here.
function Test-Title($titles, [string]$group) {
    @($titles | Where-Object { $_ -ceq $group -or ($_ -replace '\(\d+\)$', '') -ceq $group }).Count -gt 0
}

function Test-OpenChat($window, [string]$group) {
    $image = Get-WindowImage $window
    if (-not $image) { return $false }
    try { Test-Title (Get-Titles $image) $group } finally { $image.Dispose() }
}

# Search results open as a separate tool window over the session list.
function Get-SearchPopup($window) {
    $root = [Win]::RootAt($window.Left + [int]($script:column / 2), $window.Top + [int]($window.Height / 2))
    if ($root -eq $window.Handle) { return $null }
    $owner = [uint32]0
    [Win]::GetWindowThreadProcessId($root, [ref]$owner) | Out-Null
    if (@(Get-Process Weixin -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) -notcontains [int]$owner) { return $null }
    $className = New-Object System.Text.StringBuilder 256
    [Win]::GetClassName($root, $className, 256) | Out-Null
    if ("$className" -notlike '*QWindowToolSaveBits') { return $null }
    $rect = New-Object Win+RECT
    [Win]::GetWindowRect($root, [ref]$rect) | Out-Null
    [pscustomobject]@{ Handle = $root; Width = $rect.Right - $rect.Left; Height = $rect.Bottom - $rect.Top }
}

# The row Enter would open: the first band down the popup in a colour other than its background.
# It isn't always a chat. Searching for File Transfer Assistant highlighted a web search suggestion,
# and Enter opened a browser window instead. The popup's transparent margin captures as black.
function Find-HighlightedBand([System.Drawing.Bitmap]$popup) {
    $x = $popup.Width - 1
    $middle = [int]($popup.Height / 2)
    while ($x -gt 0 -and $popup.GetPixel($x, $middle).GetBrightness() -lt 0.02) { $x-- }
    $x -= 8
    if ($x -le 0) { return $null }

    $bands = @()
    $start = 0
    $color = $popup.GetPixel($x, 0)
    for ($y = 1; $y -le $popup.Height; $y++) {
        $next = if ($y -lt $popup.Height) { $popup.GetPixel($x, $y) } else { $null }
        if (-not $next -or $next.ToArgb() -ne $color.ToArgb()) {
            if ($y - $start -ge 12 -and $color.GetBrightness() -ge 0.02) { $bands += [pscustomobject]@{ Top = $start; Bottom = $y; Argb = $color.ToArgb() } }
            $start = $y
            $color = $next
        }
    }
    if (-not $bands.Count) { return $null }
    $background = ($bands | Group-Object Argb | ForEach-Object {
        [pscustomobject]@{ Argb = [int]$_.Name; Height = ($_.Group | ForEach-Object { $_.Bottom - $_.Top } | Measure-Object -Sum).Sum }
    } | Sort-Object Height -Descending | Select-Object -First 1).Argb
    $bands | Where-Object { $_.Argb -ne $background } | Select-Object -First 1
}

function Test-HighlightedRow([System.Drawing.Bitmap]$popup, [string]$group) {
    $band = Find-HighlightedBand $popup
    if (-not $band) { return $false }
    $lines = @(Read-Lines $popup 3 $false) + @(Read-Lines $popup 3 $true) + @(Read-Lines $popup 2 $true) + @(Read-Lines $popup 1 $true)
    @($lines | Where-Object { $_.Text -ceq $group -and $_.Y -ge $band.Top - 5 -and $_.Y -lt $band.Bottom }).Count -gt 0
}

function Open-Group($window, [string]$group) {
    if (Test-OpenChat $window $group) { return }

    # A search left open would get this name added to whatever is already in it.
    if (Get-SearchPopup $window) {
        [Keys]::Combo($VK_ESCAPE)
        Start-Sleep -Milliseconds 600
    }
    Assert-Foreground $window
    [Keys]::Combo($VK_CONTROL, $VK_F)
    Start-Sleep -Milliseconds 500
    Send-Text $window $group
    Start-Sleep -Milliseconds 1200

    $found = Get-SearchPopup $window
    if (-not $found) { Stop-Send 'search-failed' }
    $image = Get-WindowImage $found
    $isTopHit = $false
    if ($image) {
        try { $isTopHit = Test-HighlightedRow $image $group } finally { $image.Dispose() }
    }
    if (-not $isTopHit) {
        [Keys]::Combo($VK_ESCAPE)
        Stop-Send 'not-top-result'
    }

    Assert-Foreground $window
    [Keys]::Combo($VK_RETURN)
    Start-Sleep -Milliseconds 1200
    if (-not (Test-OpenChat $window $group)) { Stop-Send 'wrong-chat' }
}

# Where typed text shows: inside the input box, above the row of icons and the send button.
function Get-InputArea([System.Drawing.Bitmap]$image) {
    $box = Find-InputBox $image
    if (-not $box) { return $null }
    $top = $box.Top + [int](6 * $script:dpi)
    $left = $script:column + [int](14 * $script:dpi)
    $width = $image.Width - $left - [int](30 * $script:dpi)
    $height = $box.Bottom - $top - [int](50 * $script:dpi)
    if ($width -le 0 -or $height -le 0) { return $null }
    New-Object System.Drawing.Rectangle $left, $top, $width, $height
}

# Going by pixels, because OCR has trouble with what's in this box. Text covers several columns
# where a blinking caret covers one or two.
function Test-InputEmpty([System.Drawing.Bitmap]$image) {
    $area = Get-InputArea $image
    if (-not $area) { return $false }
    $base = $image.GetPixel($area.Right - 1, $area.Bottom - 1)
    $columns = 0
    for ($x = $area.Left; $x -lt $area.Right; $x++) {
        for ($y = $area.Top; $y -lt $area.Bottom; $y += 2) {
            $pixel = $image.GetPixel($x, $y)
            if ([math]::Abs($pixel.R - $base.R) + [math]::Abs($pixel.G - $base.G) + [math]::Abs($pixel.B - $base.B) -gt 60) {
                $columns++
                break
            }
        }
    }
    $columns -le 4
}

function Get-Normalized([string]$text) { ($text -replace '\s', '').Normalize([Text.NormalizationForm]::FormKC) }

function Get-Tail([string]$text, [int]$length) { if ($text.Length -gt $length) { $text.Substring($text.Length - $length) } else { $text } }

# The Chinese OCR reads Latin poorly, so text that's mostly Latin can't be checked by reading it.
function Test-MostlyChinese([string]$normalized) {
    $chinese = @($normalized.ToCharArray() | Where-Object { [int]$_ -ge 0x4E00 -and [int]$_ -le 0x9FFF }).Count
    $chinese * 2 -ge $normalized.Length
}

# OCR is too poor on this text to compare it as a whole: five typed characters came back across
# seven reads as, among others, a split character and two wrong ones, a different way each time. So
# this only asks whether at least half of the characters turn up somewhere across the reads, which
# tells roughly the right text from something else. A long text has scrolled, so its end is what shows.
function Test-CharactersSeen([string]$seen, [string]$wanted) {
    $tail = Get-Tail $wanted 40
    $found = @($tail.ToCharArray() | Where-Object { $seen.Contains([string]$_) }).Count
    $found * 2 -ge $tail.Length
}

function Test-TypedText([System.Drawing.Bitmap]$image, [string]$text) {
    $wanted = Get-Normalized $text
    if (-not (Test-MostlyChinese $wanted)) { return $true }
    $area = Get-InputArea $image
    $box = $image.Clone($area, $image.PixelFormat)
    try {
        $seen = ''
        foreach ($read in @(@(3, $false), @(3, $true), @(2, $false), @(2, $true), @(1, $false), @(1, $true))) {
            $seen += -join @(Read-Lines $box $read[0] $read[1] | ForEach-Object { $_.Text })
        }
        Test-CharactersSeen $seen $wanted
    } finally { $box.Dispose() }
}

function Clear-Typed($window) {
    if (-not (Test-Foreground $window)) { return }
    [Keys]::Combo($VK_CONTROL, $VK_A)
    Start-Sleep -Milliseconds 100
    [Keys]::Combo($VK_BACK)
}

# The sent message should now be the lowest thing in the message area. OCR does even worse on its
# green bubble, so this asks the same loose question as the check on typed text, of the lowest few
# lines in each read, since a long message wraps.
function Test-MessageShown([System.Drawing.Bitmap]$image, [string]$text) {
    $wanted = Get-Normalized $text
    if (-not (Test-MostlyChinese $wanted)) { return $true }
    $top = $script:header
    $area = New-Object System.Drawing.Rectangle $script:column, $top, ($image.Width - $script:column), ((Find-InputTop $image) - $top)
    $messages = $image.Clone($area, $image.PixelFormat)
    try {
        $seen = ''
        foreach ($read in @(@(3, $false), @(3, $true), @(2, $false), @(2, $true), @(1, $false), @(4, $false))) {
            $seen += -join @(Read-Lines $messages $read[0] $read[1] | Sort-Object Y | Select-Object -Last 4 | ForEach-Object { $_.Text })
        }
        Test-CharactersSeen $seen $wanted
    } finally { $messages.Dispose() }
}

# A few tries, because WeChat can take the focus back while it's still opening a chat.
function Restore-Foreground($window, [IntPtr]$previous) {
    if ($previous -eq [IntPtr]::Zero -or $previous -eq $window.Handle) { return }
    for ($try = 0; $try -lt 4; $try++) {
        [Keys]::Combo($VK_MENU)
        [Keys]::SetForegroundWindow($previous) | Out-Null
        Start-Sleep -Milliseconds 250
        if ([Win]::GetForegroundWindow() -eq $previous) { return }
    }
}

function Invoke-Send([string]$group, [string]$text, [bool]$rehearse) {
    if (-not $group -or -not $text.Trim() -or $text -match '[\x00-\x1F]') { Stop-Send 'bad-text' }

    # So nothing the owner is typing lands in the chat, and they have a moment to take their hands off.
    $deadline = (Get-Date).AddSeconds($IDLE_WAIT_SECONDS)
    while ([Win]::IdleMs() -lt $IDLE_NEEDED_MS) {
        if ((Get-Date) -gt $deadline) { Stop-Send 'owner-busy' }
        Start-Sleep -Milliseconds 200
    }

    $window = Find-WeChatWindow
    if (-not $window) { Stop-Send 'missing' }
    if ($window.Minimized) {
        [Keys]::ShowWindow($window.Handle, 9) | Out-Null   # SW_RESTORE
        Start-Sleep -Milliseconds 500
        $window = Find-WeChatWindow
        if (-not $window -or $window.Minimized) { Stop-Send 'missing' }
    }

    $previous = [Win]::GetForegroundWindow()
    try {
        [Keys]::Combo($VK_MENU)   # Windows only lets a process take the foreground right after input.
        [Keys]::SetForegroundWindow($window.Handle) | Out-Null
        Start-Sleep -Milliseconds 400
        Assert-Foreground $window

        Open-Group $window $group

        # A click in the box, because focus can be anywhere in the window.
        $image = Get-WindowImage $window
        if (-not $image) { Stop-Send 'missing' }
        try {
            $area = Get-InputArea $image
            if (-not $area) { Stop-Send 'no-input-box' }
            # Whatever is there is the owner's own unsent text, and Enter would send it too.
            if (-not (Test-InputEmpty $image)) { Stop-Send 'input-not-empty' }
            Send-Click $window ($area.Left + [int]($area.Width / 2)) ($area.Top + [int]($area.Height / 2))
        } finally { $image.Dispose() }
        Start-Sleep -Milliseconds 200

        Send-Text $window $text
        Start-Sleep -Milliseconds 500
        Assert-Foreground $window

        # The last look before it can't be taken back, all from one capture.
        $image = Get-WindowImage $window
        if (-not $image) { Clear-Typed $window; Stop-Send 'missing' }
        try {
            if (-not (Test-Title (Get-Titles $image) $group)) { Clear-Typed $window; Stop-Send 'wrong-chat' }
            if (Test-InputEmpty $image) { Stop-Send 'not-typed' }
            if (-not (Test-TypedText $image $text)) { Clear-Typed $window; Stop-Send 'typed-mismatch' }
        } finally { $image.Dispose() }

        if ($rehearse) { Clear-Typed $window; return @{ state = 'refused'; reason = 'rehearsal' } }

        Assert-Foreground $window
        [Keys]::Combo($VK_RETURN)
        Start-Sleep -Milliseconds 900

        # From here on it may have gone out, so nothing retries and nothing clears the box.
        $image = Get-WindowImage $window
        if (-not $image) { return @{ state = 'uncertain'; reason = 'no-capture' } }
        try {
            if (-not (Test-InputEmpty $image)) { return @{ state = 'uncertain'; reason = 'still-in-input' } }
            if (-not (Test-MessageShown $image $text)) { return @{ state = 'uncertain'; reason = 'not-shown' } }
            return @{ state = 'sent' }
        } finally { $image.Dispose() }
    } finally {
        Restore-Foreground $window $previous
    }
}

# Runs the checks on generated images, so a test can cover them without a real WeChat. No input is sent.
function Invoke-SelfTest {
    $d = $script:dpi
    $name = Text 0x9879, 0x76EE, 0x5468, 0x4F1A, 0x7FA4
    $font = New-Object System.Drawing.Font 'Microsoft YaHei', (15 * $d), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)

    # A popup: a transparent margin, a background, and one selected row at the given height.
    function New-Popup([int]$bandTop, [int]$bandBottom, [string]$rowText, [int]$rowY, [int]$rowX) {
        $popup = New-Object System.Drawing.Bitmap 460, 700
        $graphics = [System.Drawing.Graphics]::FromImage($popup)
        $graphics.Clear([System.Drawing.Color]::Black)
        $back = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(250, 250, 250))
        $selected = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(237, 237, 237))
        $graphics.FillRectangle($back, 20, 10, 410, 670)
        $graphics.FillRectangle($selected, 20, $bandTop, 410, $bandBottom - $bandTop)
        $graphics.DrawString($rowText, $font, [System.Drawing.Brushes]::Black, $rowX, $rowY)
        $graphics.Dispose()
        $popup
    }

    $results = @{}
    $popup = New-Popup 50 130 $name 75 100
    try {
        $results.nameInBand = Test-HighlightedRow $popup $name
        $results.otherNameInBand = Test-HighlightedRow $popup (Text 0x8D22, 0x52A1, 0x62A5, 0x9500, 0x7FA4)
        $band = Find-HighlightedBand $popup
        $results.bandTop = $band.Top
        $results.bandBottom = $band.Bottom
    } finally { $popup.Dispose() }
    # The chat is further down, with something else selected: what Enter must not be pressed for.
    $popup = New-Popup 50 93 $name 330 100
    try { $results.nameBelowBand = Test-HighlightedRow $popup $name } finally { $popup.Dispose() }

    # A window laid out like the real one: an input card with its edges, a row of icons along its
    # bottom, and the drop shadow below it. Its box is empty, then holds a caret, then holds text.
    $width = $script:column + 700
    $height = 600
    $inputTop = $height - 195
    $inputBottom = $height - 27
    $window = New-Object System.Drawing.Bitmap $width, $height
    $graphics = [System.Drawing.Graphics]::FromImage($window)
    $graphics.Clear([System.Drawing.Color]::FromArgb(250, 250, 250))
    $edge = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(226, 226, 226))
    $shadow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(216, 216, 221))
    $graphics.FillRectangle($edge, $script:column, $inputTop - 2, 700, 2)
    $graphics.FillRectangle($edge, $script:column, $inputBottom, 700, 2)
    $graphics.FillRectangle($shadow, $script:column, $height - 14, 700, 14)
    # The icons and the send button, which an empty box mustn't be mistaken for holding text.
    $graphics.FillRectangle([System.Drawing.Brushes]::Gray, $script:column + 22, $inputBottom - 42, 300, 32)
    $graphics.Dispose()
    $box = Find-InputBox $window
    $results.boxTop = $box.Top - $inputTop
    $results.boxBottom = $box.Bottom - $inputBottom
    try {
        $results.emptyIsEmpty = Test-InputEmpty $window
        $graphics = [System.Drawing.Graphics]::FromImage($window)
        $area = Get-InputArea $window
        $graphics.FillRectangle([System.Drawing.Brushes]::Black, $area.Left + 2, $area.Top + 2, 2, 20)
        $graphics.Dispose()
        $results.caretIsEmpty = Test-InputEmpty $window
        $graphics = [System.Drawing.Graphics]::FromImage($window)
        $graphics.DrawString($name, $font, [System.Drawing.Brushes]::Black, $area.Left + 10, $area.Top + 2)
        $graphics.Dispose()
        $results.textIsEmpty = Test-InputEmpty $window
        $results.readsTyped = Test-TypedText $window $name
        $results.readsOther = Test-TypedText $window (Text 0x8D22, 0x52A1, 0x62A5, 0x9500, 0x7FA4)
        # Text that's mostly Latin can't be checked this way, so it isn't held against the send.
        $results.latinAlwaysPasses = Test-TypedText $window 'hello world'

        # A sent message, in a green bubble at the bottom of the message area.
        $results.shownBeforeSending = Test-MessageShown $window $name
        $graphics = [System.Drawing.Graphics]::FromImage($window)
        $bubble = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(149, 236, 105))
        $graphics.FillRectangle($bubble, $width - 240, $inputTop - 60, 180, 40)
        $graphics.DrawString($name, $font, [System.Drawing.Brushes]::Black, $width - 230, $inputTop - 52)
        $graphics.Dispose()
        $results.shownAfterSending = Test-MessageShown $window $name
        $results.otherNotShown = Test-MessageShown $window (Text 0x8D22, 0x52A1, 0x62A5, 0x9500, 0x7FA4)
        $results.latinNotHeldAgainst = Test-MessageShown $window 'hello world'
    } finally { $window.Dispose() }

    # What real reads of real text looked like, which must pass, and how far a wrong text gets.
    $typed = Text 0x67A2, 0x53D1, 0x9001, 0x6D4B, 0x8BD5
    $misread = (Text 0x67A2, 0x53D1, 0x9009, 0x5290, 0x8BA0, 0x9172) + (Text 0x67A2, 0x53D1, 0x8FD9, 0x5219) + (Text 0x6C14, 0x90FD, 0x8BD5) + '2'
    $results.misreadPasses = Test-CharactersSeen $misread "${typed}2"
    $results.wrongTextFails = Test-CharactersSeen (Text 0x8D22, 0x52A1, 0x62A5, 0x9500, 0x7FA4) "${typed}2"
    $results.halfIsEnough = Test-CharactersSeen 'ab' 'abcd'
    $results.lessThanHalfIsNot = Test-CharactersSeen 'a' 'abc'
    $results.onlyTheEndCounts = Test-CharactersSeen (Text 0x62A5) ((Text 0x62A5) * 60 + (Text 0x7FA4) * 40)

    $group = $name
    $results.titleExact = Test-Title @($name) $group
    $results.titleWithCount = Test-Title @("$name(12)") $group
    $results.titleOneRead = Test-Title @('x', $name) $group
    $results.titleOther = Test-Title @((Text 0x8D22, 0x52A1, 0x62A5, 0x9500, 0x7FA4)) $group
    $results.titleLonger = Test-Title @("${name}2") $group
    $results.titleCountThenMore = Test-Title @("$name(12)x") $group
    $results.state = 'ok'
    $results
}

try {
    $request = ConvertFrom-Json ([Console]::In.ReadLine())
    $reply = switch ($request.command) {
        'send' { Invoke-Send $request.group $request.text ($request.rehearse -eq $true) }
        'selftest' { Invoke-SelfTest }
        default { throw "unknown command: $($request.command)" }
    }
    Write-Reply $reply
} catch {
    $message = "$($_.Exception.Message)"
    if ($message -like 'stop:*') { Write-Reply @{ state = 'refused'; reason = $message.Substring(5) } }
    else { Write-Reply @{ error = $message } }
}
