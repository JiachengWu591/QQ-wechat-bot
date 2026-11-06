# The engine's view of the WeChat window: a long-running child that answers each line on stdin
# with one line of JSON on stdout. It can read the window, open a row in the session list and
# scroll the open chat. Those go to WeChat's main window as posted messages, which neither take
# focus nor move the cursor. There is no way to type or send from here: that's wx-send.ps1, which
# only ever runs when the owner approves a reply.
# Keep this file ASCII: Windows PowerShell 5.1 misreads UTF-8 that has no BOM.
. (Join-Path $PSScriptRoot 'wx-common.ps1')

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

# The open chat only. The session list shows other chats' names and messages, so it stays here,
# and an unsent draft in the input box isn't sent to anyone.
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

function Invoke-OpenRow([int]$y) {
    $window = Find-WeChatWindow
    if (-not $window) { return @{ state = 'missing' } }
    if ($window.Minimized) { return @{ state = 'minimized' } }
    if ($y -lt $script:header -or $y -ge $window.Height) { throw "row is outside the session list: $y" }

    Send-Click $window ([int]($script:column / 2)) $y
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

function Get-EditDistance([string]$a, [string]$b) {
    $previous = @(0..$b.Length)
    for ($i = 1; $i -le $a.Length; $i++) {
        $current = @($i) + @(0) * $b.Length
        for ($j = 1; $j -le $b.Length; $j++) {
            $cost = if ($a[$i - 1] -ceq $b[$j - 1]) { 0 } else { 1 }
            $current[$j] = [math]::Min([math]::Min($current[$j - 1] + 1, $previous[$j] + 1), $previous[$j - 1] + $cost)
        }
        $previous = $current
    }
    $previous[$b.Length]
}

# Where a chat's row may be in the session list, closest reads of its name first, and which chat is
# open now. The list's reads of a name can be a character or two off, which only decides what gets
# clicked: whoever opens it checks the title, which is read far better.
function Invoke-LocateChat([string]$name) {
    $window = Find-WeChatWindow
    if (-not $window) { return @{ state = 'missing' } }
    if ($window.Minimized) { return @{ state = 'minimized' } }
    $image = Get-WindowImage $window
    if (-not $image) { return @{ state = 'blank' } }
    try {
        $area = New-Object System.Drawing.Rectangle 0, $script:header, ([math]::Min($script:column, $window.Width)), ($window.Height - $script:header)
        $list = $image.Clone($area, $image.PixelFormat)
        try { $lines = @(Read-Lines $list 3 $false) + @(Read-Lines $list 3 $true) } finally { $list.Dispose() }
        $rows = @(Select-ChatRows $lines $name | ForEach-Object { $_ + $script:header })
        @{ state = 'ok'; titles = (Get-Titles $image); rows = $rows; foreground = (Test-Foreground $window); idleMs = [Win]::IdleMs() }
    } finally { $image.Dispose() }
}

# Names start at the list's text column. One row is read several times, so reads close together count once.
function Select-ChatRows($lines, [string]$name) {
    $wanted = $name -replace '\s', ''
    $near = @($lines | Where-Object { $_.Text.Length -ge 4 -and [math]::Abs($_.X - 125 * $script:dpi) -lt 15 * $script:dpi } |
        ForEach-Object { [pscustomobject]@{ Y = [int]$_.Y; Distance = (Get-EditDistance $_.Text $wanted) } } |
        Where-Object { $_.Distance -le 2 } | Sort-Object Distance, Y)
    $rows = @()
    foreach ($line in $near) {
        if (@($rows | Where-Object { [math]::Abs($_ - $line.Y) -lt 30 * $script:dpi }).Count) { continue }
        $rows += $line.Y
    }
    $rows
}

# The reads a real list gave of File Transfer Assistant's row, which never once came out exact.
function Invoke-SelfTestLocate {
    $d = $script:dpi
    $name = Text 0x6587, 0x4EF6, 0x4F20, 0x8F93, 0x52A9, 0x624B
    $line = { param($text, $x, $y) [pscustomobject]@{ Text = $text; X = $x * $d; Y = $y * $d } }
    $lines = @(
        (& $line (Text 0x6587, 0x4E13, 0x8F93, 0x52A9, 0x624B) 125 340)                   # A character lost, one misread
        (& $line (Text 0x6587, 0x4EF6, 0x52A9, 0x624B) 125 341)                           # Two lost
        (& $line (Text 0x6587, 0x725B, 0x4F20, 0x8F93, 0x52A9, 0x624B) 125 340)           # One misread
        (& $line $name 200 120)                                                           # Exact, but not where names start
        (& $line ((Text 0x6587, 0x4EF6) + 'ABCD') 125 200)                                # Too different
        (& $line ($name + 'X') 125 470)                                                   # A closer chat further down
    )
    @{ state = 'ok'; rows = @(Select-ChatRows $lines $name | ForEach-Object { [int]($_ / $d) }) }
}

# A forwarded chat record opens in a window of its own. Its pages are lined up by their rows across
# the whole width: the right part alone holds little but the time, which is the same for every
# message in a minute, and lining up by that once dropped a message. A moving sticker never looks the
# same twice, so each page is captured twice and rows that changed in between are left out.
# What's joined up is cut where a row is a single colour, so no line of text is split between images.
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public static class Strip {
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  // Behind every other window, without activating it, moving it or resizing it.
  public static bool SendToBack(IntPtr h) { return SetWindowPos(h, (IntPtr)1, 0, 0, 0, 0, 0x13); }
  static byte[] Pixels(Bitmap b, out int stride) {
    var data = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    stride = data.Stride;
    var bytes = new byte[data.Stride * b.Height];
    Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
    b.UnlockBits(data);
    return bytes;
  }
  public static long[] Rows(Bitmap b, int x0, int x1) {
    int stride; var p = Pixels(b, out stride);
    var rows = new long[b.Height];
    for (int y = 0; y < b.Height; y++) {
      long sum = 0;
      for (int x = x0; x < x1; x++) { int i = y * stride + x * 4; sum += p[i] + 3 * p[i + 1] + 7 * p[i + 2]; }
      rows[y] = sum;
    }
    return rows;
  }
  // Rows with a single colour from x0 to x1.
  public static bool[] Plain(Bitmap b, int x0, int x1) {
    int stride; var p = Pixels(b, out stride);
    var plain = new bool[b.Height];
    for (int y = 0; y < b.Height; y++) {
      int first = y * stride + x0 * 4; bool same = true;
      for (int x = x0 + 1; x < x1 && same; x++) {
        int i = y * stride + x * 4;
        same = p[i] == p[first] && p[i + 1] == p[first + 1] && p[i + 2] == p[first + 2];
      }
      plain[y] = same;
    }
    return plain;
  }
  // Rows that differ between two captures of the same view, and their neighbours.
  public static bool[] Moving(long[] a, long[] b, long tolerance) {
    var moving = new bool[a.Length];
    for (int y = 0; y < a.Length; y++) {
      if (Math.Abs(a[y] - b[y]) <= tolerance) continue;
      for (int n = Math.Max(0, y - 2); n <= Math.Min(a.Length - 1, y + 2); n++) moving[n] = true;
    }
    return moving;
  }
  // Gray and blurred a little across and down. The window scrolls by fractions of a pixel, which
  // changes how every edge of the text is drawn, so the same text never quite matches itself; once
  // blurred it nearly does, while different text still doesn't.
  public static byte[] Soft(Bitmap b) {
    int stride; var p = Pixels(b, out stride);
    int w = b.Width, h = b.Height, r = 2;
    var gray = new int[w * h];
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) { int i = y * stride + x * 4; gray[y * w + x] = (p[i] + 3 * p[i + 1] + 6 * p[i + 2]) / 10; }
    var across = new int[w * h];
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
      int sum = 0, n = 0;
      for (int k = Math.Max(0, x - r); k <= Math.Min(w - 1, x + r); k++) { sum += gray[y * w + k]; n++; }
      across[y * w + x] = sum / n;
    }
    var soft = new byte[w * h];
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
      int sum = 0, n = 0;
      for (int k = Math.Max(0, y - r); k <= Math.Min(h - 1, y + r); k++) { sum += across[k * w + x]; n++; }
      soft[y * w + x] = (byte)(sum / n);
    }
    return soft;
  }
  // How far the content moved up from a to b: row y of b shows what row y + d of a did. Each
  // distance is scored by how different the two look where they overlap, leaving out rows of a with
  // nothing drawn on them or that were moving. Of equal scores the largest distance wins, since
  // joining too much repeats a line where too little loses one. A distance off by one message can
  // look much like the right one, so the best has to be clearly better than anything more than a few
  // pixels away from it. -1 when it isn't, or too few rows were there to go by.
  public static int Shift(byte[] a, byte[] b, int width, bool[] skipA, int x0, int x1, int top, int bottom, int minOverlap, out bool exact) {
    exact = false;
    int count = bottom - top - minOverlap + 1;
    if (count < 1) return -1;
    var score = new double[count]; var used = new int[count];
    // The blur reaches past the message area at its edges, into what doesn't scroll, so the rows
    // next to them are left out. A distance with only a few rows to go by can look perfect by chance,
    // say when all that's left is the same rule under several messages, so it doesn't count.
    const int edge = 3, fewest = 20;
    for (int d = 0; d < count; d++) {
      long sum = 0; int rows = 0;
      for (int y = top + edge; y + d < bottom - edge; y++) {
        if (skipA[y + d]) continue;
        rows++;
        int ra = (y + d) * width, rb = y * width;
        for (int x = x0; x < x1; x += 2) sum += Math.Abs(a[ra + x] - b[rb + x]);
      }
      used[d] = rows;
      score[d] = rows >= fewest ? (double)sum / rows : double.MaxValue;
    }
    int best = 0;
    for (int d = 0; d < count; d++) if (score[d] <= score[best]) best = d;
    if (score[best] == double.MaxValue) return -1;
    double other = double.MaxValue;
    for (int d = 0; d < count; d++) if (Math.Abs(d - best) > 8 && score[d] < other) other = score[d];
    exact = score[best] == 0;
    return score[best] <= 0.35 * other ? best : -1;
  }
  // The last row at or above limit, and below floor, that has a single colour from x0 to x1.
  public static int PlainRowAbove(Bitmap b, int limit, int floor, int x0, int x1) {
    var plain = Plain(b, x0, x1);
    for (int y = Math.Min(limit, b.Height - 1); y > floor; y--) if (plain[y]) return y;
    return -1;
  }
  // Where to cut, at or above limit: the middle of the widest blank gap in the last stretch, which is
  // between two messages rather than between a name and what that person said. Of gaps as wide, the
  // lowest, so images stay as tall as they may. Failing that, any blank row above floor, or -1.
  public static int CutRow(Bitmap b, int limit, int floor, int x0, int x1) {
    var plain = Plain(b, x0, x1);
    limit = Math.Min(limit, b.Height - 1);
    int near = Math.Max(floor, limit - 250);
    int bestStart = -1, bestLength = 0, y = limit;
    while (y > near) {
      if (!plain[y]) { y--; continue; }
      int end = y;
      while (y > near && plain[y]) y--;
      if (end - y > bestLength) { bestLength = end - y; bestStart = y + 1; }
    }
    if (bestLength > 0) return bestStart + bestLength / 2;
    for (y = near; y > floor; y--) if (plain[y]) return y;
    return -1;
  }
}
'@

$WM_CLOSE = [uint32]0x0010
$script:recordWord = Text 0x804A, 0x5929, 0x8BB0, 0x5F55
# Each image the model gets stays under its size limits at this height.
$script:sliceHeight = 1400

function Get-WeChatWindows {
    $owners = @(Get-Process Weixin -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    foreach ($handle in [Win]::All()) {
        $owner = [uint32]0
        [Win]::GetWindowThreadProcessId($handle, [ref]$owner) | Out-Null
        if ($owners -notcontains [int]$owner -or -not [Win]::IsWindowVisible($handle)) { continue }
        $rect = New-Object Win+RECT
        [Win]::GetWindowRect($handle, [ref]$rect) | Out-Null
        [pscustomobject]@{ Handle = $handle; Left = $rect.Left; Top = $rect.Top; Width = $rect.Right - $rect.Left; Height = $rect.Bottom - $rect.Top }
    }
}

# The lowest mention of a chat record in the open chat, which is the newest one when the chat is at
# its end. A card has the words in its title and again at its foot, and the foot is what's clicked.
function Find-RecordCard([System.Drawing.Bitmap]$image) {
    $top = $script:header
    $area = New-Object System.Drawing.Rectangle $script:column, $top, ($image.Width - $script:column), ((Find-InputTop $image) - $top)
    $chat = $image.Clone($area, $image.PixelFormat)
    try {
        $lines = @(Read-Lines $chat 3 $false) + @(Read-Lines $chat 3 $true) + @(Read-Lines $chat 2 $true)
    } finally { $chat.Dispose() }
    $lowest = @($lines | Where-Object { $_.Text.Contains($script:recordWord) } | Sort-Object Y) | Select-Object -Last 1
    if (-not $lowest) { return $null }
    [pscustomobject]@{ X = [int]($lowest.X + $script:column + 40 * $script:dpi / 1.25); Y = [int]($lowest.Y + $top + 10 * $script:dpi / 1.25) }
}

# The record window's own title, such as whose chat it was. Null when it doesn't name a chat record.
function Get-RecordTitle([System.Drawing.Bitmap]$page, [int]$contentTop) {
    $area = New-Object System.Drawing.Rectangle 0, 0, ([int]($page.Width * 0.8)), $contentTop
    $head = $page.Clone($area, $page.PixelFormat)
    try {
        $lines = @(Read-Lines $head 2 $false) + @(Read-Lines $head 2 $true) + @(Read-Lines $head 3 $false)
    } finally { $head.Dispose() }
    @($lines | Where-Object { $_.Text.Contains($script:recordWord) } | ForEach-Object { $_.Text }) | Select-Object -First 1
}

# Pixel for pixel: copied rather than blended, and never scaled for a resolution setting.
function Join-Vertical([System.Drawing.Bitmap]$upper, [System.Drawing.Bitmap]$lower) {
    $joined = New-Object System.Drawing.Bitmap $upper.Width, ($upper.Height + $lower.Height), ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($joined)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $pixel = [System.Drawing.GraphicsUnit]::Pixel
    $graphics.DrawImage($upper, (New-Object System.Drawing.Rectangle 0, 0, $upper.Width, $upper.Height), 0, 0, $upper.Width, $upper.Height, $pixel)
    $graphics.DrawImage($lower, (New-Object System.Drawing.Rectangle 0, $upper.Height, $lower.Width, $lower.Height), 0, 0, $lower.Width, $lower.Height, $pixel)
    $graphics.Dispose()
    $joined
}

function Get-Band([System.Drawing.Bitmap]$image, [int]$from, [int]$to) {
    $image.Clone((New-Object System.Drawing.Rectangle 0, $from, $image.Width, ($to - $from)), [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
}

function ConvertTo-Base64Png([System.Drawing.Bitmap]$image) {
    $memory = New-Object System.IO.MemoryStream
    try {
        $image.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
        [Convert]::ToBase64String($memory.ToArray())
    } finally { $memory.Dispose() }
}

# The rows of a capture that can't help line it up: blank ones, and ones that changed in a second
# capture of the same view from $again.
function Get-SkippedRows([System.Drawing.Bitmap]$image, [long[]]$rows, [scriptblock]$again, [int]$x0, [int]$x1, [long]$tolerance) {
    $skip = [Strip]::Plain($image, $x0, $x1)
    $second = & $again
    if ($second) {
        try {
            if ($second.Width -eq $image.Width -and $second.Height -eq $image.Height) {
                $moving = [Strip]::Moving($rows, [Strip]::Rows($second, $x0, $x1), $tolerance)
                for ($y = 0; $y -lt $skip.Length; $y++) { if ($moving[$y]) { $skip[$y] = $true } }
            }
        } finally { $second.Dispose() }
    }
    , $skip
}

# Joins pages from $nextPage, which scrolls and returns the next capture, or null when there is none,
# into images no taller than the slice height. $again captures the same view once more. The end is
# when two scrolls in a row move nothing. Where two pages can't be lined up, the whole of the later
# one is kept, so lines may repeat there.
function Join-RecordPages([System.Drawing.Bitmap]$first, [scriptblock]$nextPage, [scriptblock]$again, [int]$maxPages, [int]$contentTop, [int]$contentBottom) {
    $d = $script:dpi
    $x0 = [int](20 * $d); $x1 = $first.Width - [int](24 * $d)
    $minOverlap = [int](120 * $d)
    $tolerance = [long](2 * ($x1 - $x0))
    $slices = New-Object System.Collections.ArrayList
    $pending = Get-Band $first ([int](30 * $d)) $contentBottom
    $rows = [Strip]::Rows($first, $x0, $x1)
    $soft = [Strip]::Soft($first)
    $skip = Get-SkippedRows $first $rows $again $x0 $x1 $tolerance
    $pages = 1; $unmoved = 0; $complete = $false; $uncertain = $false
    # What each scroll was measured to move, -1 where it couldn't be. Kept for checking.
    $shifts = New-Object System.Collections.ArrayList
    try {
        while ($pages -lt $maxPages) {
            $next = & $nextPage
            if (-not $next) { break }
            try {
                if ($next.Width -ne $first.Width -or $next.Height -ne $first.Height) { break }
                $nextRows = [Strip]::Rows($next, $x0, $x1)
                $nextSoft = [Strip]::Soft($next)
                $exact = $false
                $shift = [Strip]::Shift($soft, $nextSoft, $next.Width, $skip, $x0, $x1, $contentTop, $contentBottom, $minOverlap, [ref]$exact)
                [void]$shifts.Add($shift)
                if ($shift -eq 0) {
                    $unmoved++
                    if ($unmoved -ge 2) { $complete = $true; break }
                    continue
                }
                $unmoved = 0
                # Stopped between pixels, the distance is only right to within half of one, so a row
                # more is kept: a line drawn twice, rather than a line lost.
                if ($shift -lt 0) { $uncertain = $true; $from = $contentTop }
                elseif ($exact) { $from = $contentBottom - $shift }
                else { $from = $contentBottom - $shift - 1 }
                $band = Get-Band $next $from $contentBottom
                $joined = Join-Vertical $pending $band
                $band.Dispose(); $pending.Dispose(); $pending = $joined
                $rows = $nextRows
                $soft = $nextSoft
                $skip = Get-SkippedRows $next $rows $again $x0 $x1 $tolerance
                $pages++
                while ($pending.Height -gt $script:sliceHeight) {
                    $cut = [Strip]::CutRow($pending, $script:sliceHeight, [int]($script:sliceHeight / 2), [int](10 * $d), $x1)
                    if ($cut -lt 0) { $cut = $script:sliceHeight }
                    $head = Get-Band $pending 0 $cut
                    $rest = Get-Band $pending $cut $pending.Height
                    [void]$slices.Add((ConvertTo-Base64Png $head))
                    $head.Dispose(); $pending.Dispose(); $pending = $rest
                }
            } finally { $next.Dispose() }
        }
        [void]$slices.Add((ConvertTo-Base64Png $pending))
    } finally { $pending.Dispose() }
    @{ slices = @($slices); pages = $pages; complete = $complete; uncertain = $uncertain; shifts = @($shifts) }
}

function Send-RecordWheel($record, [int]$count) {
    $position = Get-Point ($record.Left + [int]($record.Width / 2)) ($record.Top + [int]($record.Height / 2))
    $delta = [int64](-120) -band 0xFFFF
    # Spaced out, since messages in quick succession scroll further each time and can skip a line.
    for ($post = 0; $post -lt $count; $post++) {
        [Win]::PostMessage($record.Handle, $WM_MOUSEWHEEL, [IntPtr]([int64]($delta -shl 16)), $position) | Out-Null
        Start-Sleep -Milliseconds 150
    }
}

# Opens the newest chat record in the open chat, which has to be the one named, reads it to its end
# and closes it again. The record window is sent behind every other window and is never activated.
# A window that turns out not to be a record is left alone, since it could be anything.
function Invoke-CaptureRecord([string]$chat, [int]$maxPages, [int]$postsPerPage) {
    $window = Find-WeChatWindow
    if (-not $window) { return @{ state = 'missing' } }
    if ($window.Minimized) { return @{ state = 'minimized' } }
    $image = Get-WindowImage $window
    if (-not $image) { return @{ state = 'blank' } }
    try {
        $wanted = $chat -replace '\s', ''
        if (-not @((Get-Titles $image) | Where-Object { $_ -ceq $wanted }).Count) { return @{ state = 'wrong-chat' } }
        $card = Find-RecordCard $image
    } finally { $image.Dispose() }
    if (-not $card) { return @{ state = 'no-record' } }

    $before = @(Get-WeChatWindows | ForEach-Object { $_.Handle })
    Send-Click $window $card.X $card.Y
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $record = $null
    while (-not $record -and $clock.ElapsedMilliseconds -lt 3000) {
        Start-Sleep -Milliseconds 100
        $record = @(Get-WeChatWindows | Where-Object { $before -notcontains $_.Handle -and $_.Width -ge 300 -and $_.Height -ge 300 } |
            Sort-Object { $_.Width * $_.Height } -Descending) | Select-Object -First 1
    }
    if (-not $record) { return @{ state = 'not-opened' } }
    [Strip]::SendToBack($record.Handle) | Out-Null
    Start-Sleep -Milliseconds 800

    $contentTop = [int](86 * $script:dpi)
    $contentBottom = $record.Height - [int](12 * $script:dpi)
    $first = Get-WindowImage $record
    if (-not $first) { return @{ state = 'not-record' } }
    $title = Get-RecordTitle $first $contentTop
    if (-not $title) { $first.Dispose(); return @{ state = 'not-record' } }
    try {
        $next = { Send-RecordWheel $record $postsPerPage; Start-Sleep -Milliseconds 700; Get-WindowImage $record }
        $again = { Start-Sleep -Milliseconds 120; Get-WindowImage $record }
        $joined = Join-RecordPages $first $next $again $maxPages $contentTop $contentBottom
        @{ state = 'ok'; title = $title; slices = $joined.slices; pages = $joined.pages; complete = $joined.complete; uncertain = $joined.uncertain }
    } finally {
        $first.Dispose()
        [Win]::PostMessage($record.Handle, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    }
}

# A generated record, laid out like the real window at its real size: a title above, a message every
# 86 px with a name, a time and text, and now and then a picture on the left that changes on every
# capture, like a moving sticker. As in the real record that once lost a message, it starts with the
# same person sending short messages in the same minute, so the right part of the rows repeats
# exactly. After that, as in most chats, who says what and when varies. Pages scroll by the given
# steps until the end.
function Invoke-SelfTestRecord {
    $d = $script:dpi
    $width = 718; $height = 909
    $contentTop = [int](86 * $d); $contentBottom = $height - [int](12 * $d)
    $visible = $contentBottom - $contentTop
    $font = New-Object System.Drawing.Font 'Arial', 14, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
    $background = [System.Drawing.Color]::FromArgb(250, 250, 250)
    $gray = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(153, 153, 153))
    $rule = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(230, 230, 230))
    $random = New-Object System.Random 7
    $messages = @()
    for ($y = 10; $y -lt 3540; $y += 86) {
        $n = [int][math]::Floor(($y - 10) / 86)
        if ($n -lt 16) {
            $sender = "user$([math]::Floor($n / 3) % 2)"; $time = '07:{0:d2}' -f [int][math]::Floor($n / 4)
            $words = if ($n % 7 -eq 3) { 6 } else { 0 }
        } else {
            $sender = "member$($random.Next(5))"; $time = '08:{0:d2}' -f $n
            $words = 1 + $random.Next(6)
        }
        $text = if ($n % 5 -eq 2) { $null } elseif ($words) { (1..$words | ForEach-Object { "word$($random.Next(1000000))" }) -join ' ' } else { "ok$($random.Next(1000))" }
        $messages += [pscustomobject]@{ Y = $y; Sender = $sender; Time = $time; Text = $text }
    }
    $pictures = @($messages | Where-Object { -not $_.Text } | ForEach-Object { $_.Y + 24 })
    # Text is placed to a fraction of a pixel, as the real window draws it when it stops between pixels.
    $draw = {
        param($g, [double]$from, [double]$to)
        $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
        foreach ($message in $messages) {
            if ($message.Y + 86 -lt $from -or $message.Y -gt $to) { continue }
            $g.DrawString($message.Sender, $font, $gray, [single]99, [single]$message.Y)
            $g.DrawString($message.Time, $font, $gray, [single]600, [single]$message.Y)
            if ($message.Text) { $g.DrawString($message.Text, $font, [System.Drawing.Brushes]::Black, [single]99, [single]($message.Y + 24)) }
            $g.DrawLine($rule, [single]97, [single]($message.Y + 76), [single]678, [single]($message.Y + 76))
        }
    }
    $tall = New-Object System.Drawing.Bitmap $width, 3600, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($tall)
    $graphics.Clear($background)
    & $draw $graphics 0 $tall.Height
    $graphics.Dispose()
    $script:testFrame = 0
    $render = {
        param([double]$offset)
        $script:testFrame++
        $page = New-Object System.Drawing.Bitmap $width, $height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [System.Drawing.Graphics]::FromImage($page)
        $g.Clear([System.Drawing.Color]::White)
        $g.DrawString('record title', $font, [System.Drawing.Brushes]::Black, 30, 50)
        $area = New-Object System.Drawing.Rectangle 0, $contentTop, $width, $visible
        $g.SetClip($area)
        $fill = New-Object System.Drawing.SolidBrush $background
        $g.FillRectangle($fill, $area)
        $fill.Dispose()
        $g.TranslateTransform(0, [single]($contentTop - $offset))
        & $draw $g $offset ($offset + $visible)
        $g.ResetTransform()
        $moving = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, ($script:testFrame * 40) % 255, 100, 150))
        foreach ($top in $pictures) { $g.FillRectangle($moving, [single]99, [single]($top - $offset + $contentTop), [single]160, [single]48) }
        $moving.Dispose()
        $g.ResetClip()
        $g.FillRectangle([System.Drawing.Brushes]::Gainsboro, 0, $contentBottom, $width, $height - $contentBottom)
        $g.Dispose()
        $page
    }
    $last = $tall.Height - $visible
    $run = {
        param([double[]]$steps, [int]$maxPages, [double]$then = 480)
        $script:testOffset = 0.0; $script:testStep = 0
        $first = & $render 0
        $next = {
            $step = if ($script:testStep -lt $steps.Count) { $steps[$script:testStep] } else { $then }
            $script:testStep++
            $script:testOffset = [math]::Min($last, $script:testOffset + $step)
            & $render $script:testOffset
        }
        $again = { & $render $script:testOffset }
        try { Join-RecordPages $first $next $again $maxPages $contentTop $contentBottom } finally { $first.Dispose() }
    }

    # Every row is checked across the width, except where a picture is, which is never the same twice.
    $x0 = [int](20 * $d); $x1 = $width - [int](24 * $d)
    try {
        $title = & $render 0
        $titleRows = @([Strip]::Rows($title, $x0, $x1)[([int](30 * $d))..($contentTop - 1)])
        $expectedRows = $titleRows + @([Strip]::Rows($tall, $x0, $x1))
        $title.Dispose()
        $picture = New-Object bool[] $expectedRows.Count
        foreach ($top in $pictures) { for ($y = $top; $y -lt $top + 48; $y++) { $picture[$titleRows.Count + $y] = $true } }
        # Whether the slices put back together are the whole record, once, from its title to its end.
        $check = {
            param($result)
            $images = @($result.slices | ForEach-Object { New-Object System.Drawing.Bitmap (New-Object System.IO.MemoryStream (, [Convert]::FromBase64String($_))) })
            try {
                $joinedRows = @($images | ForEach-Object { [Strip]::Rows($_, $x0, $x1) } | ForEach-Object { $_ })
                $same = $joinedRows.Count -eq $expectedRows.Count
                for ($i = 0; $same -and $i -lt $expectedRows.Count; $i++) { if (-not $picture[$i] -and $joinedRows[$i] -ne $expectedRows[$i]) { $same = $false } }
                @{
                    same = $same
                    count = $images.Count
                    fit = -not @($images | Where-Object { $_.Height -gt $script:sliceHeight -or $_.Height -lt 1 }).Count
                    plainCuts = -not @($images | Select-Object -Skip 1 | Where-Object { [Strip]::PlainRowAbove($_, 0, -1, [int](10 * $d), $x1) -ne 0 }).Count
                    # A name sits about 12 blank rows above its text, and a message ends about 34 above
                    # the rule under it, so a cut between messages leaves more blank than that around it.
                    between = -not @(for ($i = 1; $i -lt $images.Count; $i++) {
                        $above = [Strip]::Plain($images[$i - 1], [int](10 * $d), $x1); $below = [Strip]::Plain($images[$i], [int](10 * $d), $x1)
                        $blank = 0
                        for ($y = $above.Length - 1; $y -ge 0 -and $above[$y]; $y--) { $blank++ }
                        for ($y = 0; $y -lt $below.Length -and $below[$y]; $y++) { $blank++ }
                        if ($blank -lt 20) { $i }
                    }).Count
                }
            } finally { $images | ForEach-Object { $_.Dispose() } }
        }

        $whole = & $run @(480, 300, 500, 480) 40
        $wholeCheck = & $check $whole
        $rowsMatch = $wholeCheck.same
        $slicesFit = $wholeCheck.fit
        $cutsPlain = $wholeCheck.plainCuts
        $cutsBetween = $wholeCheck.between
        $sliceCount = $wholeCheck.count
        # One scroll that moves nothing isn't the end yet.
        $stalled = & $run @(480, 0, 480) 40
        $stalledCheck = & $check $stalled

        # Stopping between pixels, as the real window does, with the pictures moving all the while.
        # Rows can't match exactly then, so what's counted is the rule under each message, down a
        # column only the rules reach: one too many is a repeat, one too few a loss.
        $countRules = {
            param($result)
            $count = 0
            foreach ($slice in $result.slices) {
                $image = New-Object System.Drawing.Bitmap (New-Object System.IO.MemoryStream (, [Convert]::FromBase64String($slice)))
                try {
                    $dark = $false
                    for ($y = 0; $y -lt $image.Height; $y++) {
                        $now = $image.GetPixel(670, $y).R -lt 247
                        if ($now -and -not $dark) { $count++ }
                        $dark = $now
                    }
                } finally { $image.Dispose() }
            }
            $count
        }
        $expectedRules = @(for ($y = 10; $y -lt 3540; $y += 86) { if ($y + 76 -lt $tall.Height) { $y } }).Count
        $fractional = & $run @(480.4, 300.6, 506.25, 480.8) 40 506.6
        $fractionalRules = & $countRules $fractional

        $skipped = & $run @(480, ($visible + 100), 480) 40
        $short = & $run @(480) 3
        # One page per distinct place the window stopped at.
        $expectedPages = 1; $offset = 0
        foreach ($step in @(480, 300, 500, 480) + @(480) * 20) {
            if ($offset -ge $last) { break }
            $offset = [math]::Min($last, $offset + $step); $expectedPages++
        }
        @{
            state = 'ok'
            complete = $whole.complete
            uncertain = $whole.uncertain
            pages = $whole.pages
            expectedPages = $expectedPages
            rowsMatch = $rowsMatch
            slices = $sliceCount
            slicesFit = $slicesFit
            cutsPlain = $cutsPlain
            cutsBetween = $cutsBetween
            stalledComplete = $stalled.complete
            stalledRowsMatch = $stalledCheck.same
            fractionalComplete = $fractional.complete
            fractionalUncertain = $fractional.uncertain
            fractionalRules = $fractionalRules
            expectedRules = $expectedRules
            # What each scroll was measured to move, to see where a failure came from.
            shifts = (@($whole.shifts) -join ',') + ' / ' + (@($fractional.shifts) -join ',') + ' / ' + (@($skipped.shifts) -join ',')
            skippedIsUncertain = $skipped.uncertain
            skippedComplete = $skipped.complete
            shortPages = $short.pages
            shortComplete = $short.complete
        }
    } finally { $tall.Dispose() }
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

# Runs the cropping code on a generated window laid out like the real one: a dark list, a title, a
# message area, an input card with its edges, and the drop shadow below it. The card's height and
# the shadow's come from measuring a real window at 125% scale.
function Invoke-SelfTestChat {
    $width = $script:column + 700
    $height = 600
    $inputTop = $height - 195
    $inputBottom = $height - 27
    $image = New-Object System.Drawing.Bitmap $width, $height
    $graphics = [System.Drawing.Graphics]::FromImage($image)
    $graphics.Clear([System.Drawing.Color]::FromArgb(250, 250, 250))
    $list = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(120, 0, 0))
    $edge = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(226, 226, 226))
    $shadow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(216, 216, 221))
    $graphics.FillRectangle($list, 0, 0, $script:column, $height)
    $graphics.FillRectangle($edge, $script:column, $inputTop - 2, 700, 2)
    $graphics.FillRectangle($edge, $script:column, $inputBottom, 700, 2)
    $graphics.FillRectangle($shadow, $script:column, $height - 14, 700, 14)
    $font =New-Object System.Drawing.Font 'Microsoft YaHei', (15 * $script:dpi), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
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
            'locateChat' { Invoke-LocateChat $request.name }
            'captureRecord' { Invoke-CaptureRecord $request.chat $request.maxPages $request.postsPerPage }
            'selftestRecord' { Invoke-SelfTestRecord }
            'selftestLocate' { Invoke-SelfTestLocate }
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
