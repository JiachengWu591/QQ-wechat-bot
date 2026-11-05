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
