# Checks what the WeChat workbench (M4) depends on. Nothing here types into a chat input or
# presses send, and no image leaves this computer. Chat text is never printed.
#   powershell -File 08-wx-workbench.ps1 -Mode Covered -Code 4821
#       With WeChat covered by another window, waits for a message containing the code to show
#       up in the capture. Proves a covered window still updates. Sends no input at all.
#   powershell -File 08-wx-workbench.ps1 -Mode Switch -NameFile output\wx-target.txt
#       Opens the named chat through WeChat search, checks its title, then goes back to File
#       Transfer Assistant. Takes the foreground and types into the search box only. Opening a
#       chat marks it as read, as it would by hand.
#   powershell -File 08-wx-workbench.ps1 -Mode Look -NameFile output\wx-target.txt
#       Searches for File Transfer Assistant and the named chat, reports the layout of the results
#       and which row looks selected, and closes the search. Never presses Enter.
#   powershell -File 08-wx-workbench.ps1 -Mode Click -NameFile output\wx-target.txt [-ByMarker]
#       Opens the named chat by posting a click to its row in the session list, then does the same
#       for File Transfer Assistant. No focus change, no cursor movement and no typing. With
#       -ByMarker the row is found by its mention marker, and the title then says which chat it was.
#   powershell -File 08-wx-workbench.ps1 -Mode Scroll [-Steps 5] [-Keep]
#       Scrolls the open chat up with posted wheel messages, without taking focus or moving the
#       cursor, reports whether the screen changed, then scrolls back down.
param(
    [Parameter(Mandatory)][ValidateSet('Covered', 'Switch', 'Look', 'Click', 'Scroll')][string]$Mode,
    [string]$Code,
    [string]$NameFile,
    [int]$Steps = 5,
    [int]$Posts = 6,
    [int]$WaitSeconds = 180,
    [switch]$ByMarker,
    [switch]$Keep
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'wx-common.ps1')

$VK_CONTROL = [byte]0x11; $VK_MENU = [byte]0x12; $VK_RETURN = [byte]0x0D; $VK_ESCAPE = [byte]0x1B; $VK_F = [byte]0x46
$WM_MOUSEWHEEL = [uint32]0x020A
$fileTransfer = ConvertFrom-CodePoints 0x6587, 0x4EF6, 0x4F20, 0x8F93, 0x52A9, 0x624B   # File Transfer Assistant
$outputDir = Join-Path $PSScriptRoot 'output'
New-Item -ItemType Directory -Force $outputDir | Out-Null
$checkPath = Join-Path $outputDir 'wx-workbench-check.png'

function Get-OpenWindow {
    $window = Find-WeChatWindow
    if (-not $window) { 'No visible WeChat window. Open the main window (not hidden in the tray).'; exit 1 }
    if ($window.Minimized) { 'WeChat is minimized, so it cannot be captured. Restore it first.'; exit 1 }
    $window
}

# Samples the whole window. Being in front says little: an always-on-top window can cover
# WeChat while it keeps the focus. A partly covered window also still paints, so only a fully
# covered one shows whether it keeps updating behind the user's other work.
function Get-CoveredShare($window) {
    $points = 0; $covered = 0
    foreach ($column in 0..4) {
        foreach ($row in 0..4) {
            $x = $window.Left + [int]($window.Width * (2 * $column + 1) / 10)
            $y = $window.Top + [int]($window.Height * (2 * $row + 1) / 10)
            $points++
            if ([Win]::RootAt($x, $y) -ne $window.Handle) { $covered++ }
        }
    }
    "$covered of $points points"
}

function Save-Chat($window, [string]$path) {
    $whole = "$path.whole.png"
    try {
        Save-WindowImage $window $whole | Out-Null
        Save-ChatArea $whole $window $path
    } finally { Remove-Item $whole -ErrorAction SilentlyContinue }
}

# The share of sampled pixels that differ, which tells whether a scroll did anything.
function Get-ChangedPercent([string]$first, [string]$second) {
    $a = [System.Drawing.Bitmap]::FromFile($first); $b = [System.Drawing.Bitmap]::FromFile($second)
    try {
        $samples = 0; $changed = 0
        for ($x = 0; $x -lt $a.Width; $x += [math]::Max(1, [int]($a.Width / 80))) {
            for ($y = 0; $y -lt $a.Height; $y += [math]::Max(1, [int]($a.Height / 60))) {
                $samples++
                if ($a.GetPixel($x, $y).ToArgb() -ne $b.GetPixel($x, $y).ToArgb()) { $changed++ }
            }
        }
        [math]::Round(100 * $changed / $samples, 1)
    } finally { $a.Dispose(); $b.Dispose() }
}

function Assert-Foreground($window) {
    if ([Win]::GetForegroundWindow() -ne $window.Handle) { throw 'WeChat lost focus. Stopped before sending any more input.' }
}

function Send-Text($window, [string]$value) {
    if ($value -match '[\x00-\x1F]') { throw 'Text contains a line break or control character. Nothing was typed.' }
    foreach ($character in $value.ToCharArray()) {
        Assert-Foreground $window
        if (-not [Win]::TypeChar($character)) { throw 'Windows rejected the simulated input.' }
        Start-Sleep -Milliseconds 40
    }
}

# Reports how the title matched, not what it said, since a wrong chat's name is private.
function Get-TitleMatch($window, [string]$name) {
    try {
        Save-WindowImage $window $checkPath | Out-Null
        $lines = @(Read-HeaderLines $checkPath $window | Where-Object { $_.X -ge $window.ColumnWidth -and $_.Y -lt $window.HeaderHeight })
    } finally { Remove-Item $checkPath -ErrorAction SilentlyContinue }
    $countSuffix = '[\(' + [char]0xFF08 + ']\d+[\)' + [char]0xFF09 + ']$'   # half-width or full-width brackets
    $closest = if ($lines.Count) { ($lines | ForEach-Object { Get-EditDistance ($_.Text -replace $countSuffix, '') $name } | Measure-Object -Minimum).Minimum } else { -1 }
    [pscustomobject]@{
        Exact = @($lines | Where-Object { $_.Text -ceq $name }).Count -gt 0
        WithMemberCount = @($lines | Where-Object { ($_.Text -replace $countSuffix, '') -ceq $name }).Count -gt 0
        ClosestDistance = $closest
    }
}

# Search results open as a separate Qt tool window over the session list. Its being there is a
# firmer sign that typing reached the search box than reading the box: a two-character name
# read back with both characters wrong on real WeChat.
function Get-SearchPopup($window) {
    $root = [Win]::RootAt($window.Left + [int]($window.ColumnWidth / 2), $window.Top + [int]($window.Height / 2))
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

# Enter opens the top result. Section headings sit further left than result rows.
function Test-TopResult($popup, [string]$name) {
    try {
        Save-WindowImage $popup $checkPath | Out-Null
        $lines = @(Read-OcrAll $checkPath) + @(Read-OcrLines $checkPath -Scale 2) + @(Read-OcrLines $checkPath -Scale 1)
    } finally { Remove-Item $checkPath -ErrorAction SilentlyContinue }
    $rows = @($lines | Where-Object { $_.X -gt 80 })
    if (-not $rows.Count) { return $false }
    $topY = ($rows | Measure-Object -Property Y -Minimum).Minimum
    @($rows | Where-Object { [math]::Abs($_.Y - $topY) -lt 12 -and $_.Text -ceq $name }).Count -gt 0
}

# Positions and matches only, since results can include other people's names. The colour bands
# down the right edge show which row is selected, without needing to read anything.
function Show-Popup($popup, [string]$name) {
    $webSearch = ConvertFrom-CodePoints 0x641C, 0x4E00, 0x641C   # the web search entry's name
    try {
        Save-WindowImage $popup $checkPath | Out-Null
        $lines = @(Read-OcrAll $checkPath) + @(Read-OcrLines $checkPath -Scale 2) + @(Read-OcrLines $checkPath -Scale 1)
        $bitmap = [System.Drawing.Bitmap]::FromFile($checkPath)
        try {
            # The popup has a transparent margin that captures as black.
            $x = $popup.Width - 1
            while ($x -gt 0 -and $bitmap.GetPixel($x, [int]($popup.Height / 2)).GetBrightness() -lt 0.02) { $x-- }
            $x -= 8
            "  right edge of the content at x=$($x + 8)"
            $start = 0; $color = $bitmap.GetPixel($x, 0)
            for ($y = 1; $y -le $popup.Height; $y++) {
                $next = if ($y -lt $popup.Height) { $bitmap.GetPixel($x, $y) } else { $null }
                if (-not $next -or $next.ToArgb() -ne $color.ToArgb()) {
                    if ($y - $start -ge 12) { "  band y=$start to $y, colour $($color.R),$($color.G),$($color.B)" }
                    $start = $y; $color = $next
                }
            }
        } finally { $bitmap.Dispose() }
    } finally { Remove-Item $checkPath -ErrorAction SilentlyContinue }
    $seen = @{}
    foreach ($line in $lines | Sort-Object Y) {
        $key = '{0}:{1}' -f [int]($line.Y / 8), $line.Text
        if ($seen[$key]) { continue }
        $seen[$key] = $true
        $isName = $line.Text -ceq $name
        $isWeb = $line.Text.Contains($webSearch)
        if ($line.Y -lt 400) {
            "  line x=$([int]$line.X) y=$([int]$line.Y) length $($line.Text.Length), the name: $isName, contains it: $($line.Text.Contains($name)), distance: $(Get-EditDistance $line.Text $name), web search: $isWeb"
        }
    }
}

function Open-Chat($window, [string]$name) {
    Assert-Foreground $window
    [Win]::Combo($VK_CONTROL, $VK_F); Start-Sleep -Milliseconds 500
    Send-Text $window $name
    Start-Sleep -Milliseconds 1000
    $popup = Get-SearchPopup $window
    try {
        Save-WindowImage $window $checkPath | Out-Null
        $location = Get-PasteLocation (Read-EditAreaLines $checkPath $window) $window ($name -replace '\s', '')
    } finally { Remove-Item $checkPath -ErrorAction SilentlyContinue }
    "  Results popup open: $([bool]$popup), typed name read in chat input: $($location.InChatInput)"
    if ($location.InChatInput -or -not $popup) {
        '  Search was not confirmed, so Enter was not pressed. Check the chat input box and clear it if the name landed there.'
        exit 1
    }
    $topIsName = Test-TopResult $popup $name
    "  Top result is exactly this name: $topIsName"
    if (-not $topIsName) {
        '  Enter was not pressed, because it would open a different chat. The search is still open.'
        exit 1
    }
    Assert-Foreground $window
    [Win]::Combo($VK_RETURN); Start-Sleep -Milliseconds 1200
    $match = Get-TitleMatch $window $name
    "  Popup closed: $(-not (Get-SearchPopup $window)). Title exact: $($match.Exact), exact apart from a member count: $($match.WithMemberCount), closest distance: $($match.ClosestDistance)"
}

if ($Mode -eq 'Covered') {
    if ($Code -notmatch '^\d{4,8}$') { 'Pass -Code with 4 to 8 digits.'; exit 1 }
    $window = Get-OpenWindow
    "Covered: $(Get-CoveredShare $window). WeChat has focus: $([Win]::GetForegroundWindow() -eq $window.Handle). Waiting up to $WaitSeconds s for the code."
    $started = Get-Date
    $reads = 0
    try {
        while (((Get-Date) - $started).TotalSeconds -lt $WaitSeconds) {
            $stats = Save-WindowImage $window $checkPath
            $reads++
            $hits = @(Read-OcrAll $checkPath | Where-Object { $_.Text.Contains($Code) })
            if ($hits.Count) {
                $where = if (@($hits | Where-Object { $_.X -ge $window.ColumnWidth }).Count) { 'chat area' } else { 'session list only' }
                "Seen after $([int]((Get-Date) - $started).TotalSeconds) s and $reads reads, in the $where. Black pixels: $($stats.DarkPercent)%. Covered: $(Get-CoveredShare $window)."
                exit 0
            }
            Start-Sleep -Seconds 2
        }
    } finally { Remove-Item $checkPath -ErrorAction SilentlyContinue }
    "Not seen in $reads reads. Last black pixels: $($stats.DarkPercent)%."
    exit 1
}

if ($Mode -eq 'Click') {
    if (-not $NameFile -or -not (Test-Path $NameFile)) { 'Pass -NameFile with the chat name in a UTF-8 file.'; exit 1 }
    $name = [IO.File]::ReadAllText((Resolve-Path $NameFile), [Text.Encoding]::UTF8).Trim()
    $window = Get-OpenWindow
    $foregroundBefore = [Win]::GetForegroundWindow()
    $cursorBefore = New-Object Win+POINT 0, 0
    [Win]::GetCursorPos([ref]$cursorBefore) | Out-Null
    "Covered: $(Get-CoveredShare $window). WeChat in front: $($foregroundBefore -eq $window.Handle)."

    foreach ($term in $name, $fileTransfer) {
        "Looking for a row named with $($term.Length) characters:"
        try {
            Save-WindowImage $window $checkPath | Out-Null
            $list = @(Read-RegionLines $checkPath 0 $window.HeaderHeight $window.ColumnWidth ($window.Height - $window.HeaderHeight) -ExtraContrastScales 1, 2)
        } finally { Remove-Item $checkPath -ErrorAction SilentlyContinue }
        if ($ByMarker -and $term -ceq $name) {
            $markers = @($list | Where-Object { Test-MentionMarker $_.Text })
            $rowsWithMarker = @($markers | ForEach-Object { [int]($_.Y / 40) } | Sort-Object -Unique)
            "  Marker read $($markers.Count) times, on $($rowsWithMarker.Count) rows, at y=$(($markers | ForEach-Object { [int]$_.Y } | Sort-Object -Unique) -join ',')"
            if ($rowsWithMarker.Count -ne 1) { '  Not exactly one row has the marker, so nothing was clicked.'; exit 1 }
            $row = $markers[0]
        } else {
            # Only a row reading exactly the name gets clicked, since a click marks that chat as read.
            $row = @($list | Where-Object { $_.Text -ceq $term } | Sort-Object Y) | Select-Object -First 1
            if (-not $row) { '  No row reads exactly this name, so nothing was clicked.'; exit 1 }
        }
        $x = [int]($window.ColumnWidth / 2); $y = [int]($row.Y + 10)
        "  Row at y=$y. Clicking."
        $position = [IntPtr](($x -band 0xFFFF) -bor (($y -band 0xFFFF) -shl 16))
        [Win]::PostMessage($window.Handle, 0x0200, [IntPtr]::Zero, $position) | Out-Null   # WM_MOUSEMOVE
        Start-Sleep -Milliseconds 60
        [Win]::PostMessage($window.Handle, 0x0201, [IntPtr]1, $position) | Out-Null        # WM_LBUTTONDOWN
        Start-Sleep -Milliseconds 60
        [Win]::PostMessage($window.Handle, 0x0202, [IntPtr]::Zero, $position) | Out-Null   # WM_LBUTTONUP
        Start-Sleep -Milliseconds 1200
        $match = Get-TitleMatch $window $term
        "  Title exact: $($match.Exact), exact apart from a member count: $($match.WithMemberCount), closest distance: $($match.ClosestDistance)"
    }

    $cursorAfter = New-Object Win+POINT 0, 0
    [Win]::GetCursorPos([ref]$cursorAfter) | Out-Null
    "Focus unchanged: $([Win]::GetForegroundWindow() -eq $foregroundBefore). Cursor unchanged: $($cursorAfter.X -eq $cursorBefore.X -and $cursorAfter.Y -eq $cursorBefore.Y)."
    return
}

if ($Mode -in 'Switch', 'Look') {
    if (-not $NameFile -or -not (Test-Path $NameFile)) { 'Pass -NameFile with the chat name in a UTF-8 file.'; exit 1 }
    $name = [IO.File]::ReadAllText((Resolve-Path $NameFile), [Text.Encoding]::UTF8).Trim()
    if (-not $name) { 'The name file is empty.'; exit 1 }

    $idleDeadline = (Get-Date).AddSeconds(60)
    while ([Win]::IdleMs() -lt 3000) {
        if ((Get-Date) -gt $idleDeadline) { 'Keyboard or mouse stayed active for 60 seconds. No input was sent.'; exit 1 }
        Start-Sleep -Milliseconds 250
    }
    $window = Get-OpenWindow
    [Win]::Combo($VK_MENU)   # Windows only lets a process take the foreground right after input
    [Win]::SetForegroundWindow($window.Handle) | Out-Null
    Start-Sleep -Milliseconds 400
    Assert-Foreground $window

    # A search left open from an earlier run would get the new name added to the old one.
    if (Get-SearchPopup $window) {
        [Win]::Combo($VK_ESCAPE); Start-Sleep -Milliseconds 600
        "Closed a search that was already open: $(-not (Get-SearchPopup $window))"
    }

    # If Ctrl+F ever failed, the typed name would land in the open chat's input. Starting from
    # here means even that, followed by a wrong Enter, reaches nobody else.
    if (-not (Get-TitleMatch $window $fileTransfer).Exact) {
        'File Transfer Assistant is not the open chat. Open it by hand, then run this again. No text was typed.'
        exit 1
    }

    if ($Mode -eq 'Look') {
        foreach ($term in $fileTransfer, $name) {
            "Searching for a name of $($term.Length) characters:"
            Assert-Foreground $window
            [Win]::Combo($VK_CONTROL, $VK_F); Start-Sleep -Milliseconds 500
            Send-Text $window $term
            Start-Sleep -Milliseconds 1500
            $popup = Get-SearchPopup $window
            if (-not $popup) { '  No results popup, so stopping here. Check the chat input box and clear it if the name landed there.'; exit 1 }
            Show-Popup $popup $term
            Assert-Foreground $window
            [Win]::Combo($VK_ESCAPE); Start-Sleep -Milliseconds 600
            "  Search closed: $(-not (Get-SearchPopup $window))"
        }
        return
    }

    "Opening the named chat ($($name.Length) characters):"
    Open-Chat $window $name
    "Going back to File Transfer Assistant:"
    Open-Chat $window $fileTransfer
    return
}

if ($Mode -eq 'Scroll') {
    $window = Get-OpenWindow
    $foregroundBefore = [Win]::GetForegroundWindow()
    $cursorBefore = New-Object Win+POINT 0, 0
    [Win]::GetCursorPos([ref]$cursorBefore) | Out-Null
    "Covered: $(Get-CoveredShare $window). WeChat in front: $($foregroundBefore -eq $window.Handle)."

    $x = $window.Left + $window.ColumnWidth + [int](($window.Width - $window.ColumnWidth) / 2)
    $y = $window.Top + [int]($window.Height * 0.45)
    $position = [IntPtr](($x -band 0xFFFF) -bor (($y -band 0xFFFF) -shl 16))
    # WeChat moves about 62 px per wheel message whatever its delta says, at 125% display scale,
    # so a longer scroll takes more messages rather than a bigger one.
    $wheel = {
        param([int]$direction)
        # The delta is a signed value in the high word, so a downward scroll needs the wider cast.
        $delta = [int64]($direction * 120) -band 0xFFFF
        foreach ($post in 1..$Posts) {
            [Win]::PostMessage($window.Handle, $WM_MOUSEWHEEL, [IntPtr]([int64]($delta -shl 16)), $position) | Out-Null
            Start-Sleep -Milliseconds 40
        }
    }

    $previous = Join-Path $outputDir 'wx-scroll-00.png'
    Save-Chat $window $previous
    $scrolled = 0
    $kept = @($previous)
    foreach ($step in 1..$Steps) {
        & $wheel 1
        Start-Sleep -Milliseconds 800
        $current = Join-Path $outputDir ('wx-scroll-{0:d2}.png' -f $step)
        Save-Chat $window $current
        $kept += $current
        $changed = Get-ChangedPercent $previous $current
        "Step ${step}: $changed% of sampled pixels changed"
        if ($changed -gt 0.5) { $scrolled++ }
        $previous = $current
    }

    foreach ($step in 1..$Steps) { & $wheel -1; Start-Sleep -Milliseconds 200 }
    Start-Sleep -Milliseconds 800

    $backPath = Join-Path $outputDir 'wx-scroll-back.png'
    Save-Chat $window $backPath
    "Back at the start, compared with the first capture: $(Get-ChangedPercent $kept[0] $backPath)% changed"
    Remove-Item $backPath -ErrorAction SilentlyContinue

    $cursorAfter = New-Object Win+POINT 0, 0
    [Win]::GetCursorPos([ref]$cursorAfter) | Out-Null
    "Steps that scrolled: $scrolled of $Steps. Focus unchanged: $([Win]::GetForegroundWindow() -eq $foregroundBefore). Cursor unchanged: $($cursorAfter.X -eq $cursorBefore.X -and $cursorAfter.Y -eq $cursorBefore.Y)."
    if ($Keep) { "Kept $($kept.Count) images in $outputDir. They show this chat, and stay on this computer." }
    else { $kept | ForEach-Object { Remove-Item $_ -ErrorAction SilentlyContinue } }
}
