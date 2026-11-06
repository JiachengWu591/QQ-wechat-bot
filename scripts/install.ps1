# Installs the packaged app for this user, the first time bringing over the development data and the
# key file, then starts it. Run it from a terminal opened from the Start menu: started from inside a
# packaged app such as Claude, Windows quietly redirects everything written under AppData into that
# app's own container, where nothing else can see it.
# Keep this file ASCII: Windows PowerShell 5.1 misreads UTF-8 that has no BOM.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $env:LOCALAPPDATA 'com.shu.console'
$program = Join-Path $env:LOCALAPPDATA 'Shu\shu-desktop.exe'

# A file written here shows up under Packages\...\LocalCache when the writes are being redirected.
$marker = Join-Path $env:LOCALAPPDATA ("shu-install-check-" + [guid]::NewGuid() + '.tmp')
Set-Content -Path $marker -Value 'check' -Encoding ascii
$redirected = @(Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName ('LocalCache\Local\' + (Split-Path -Leaf $marker))) })
Remove-Item $marker -Force
if ($redirected.Count) {
    Write-Host "This terminal belongs to $($redirected[0].Name), so Windows would put the install in its container. Open a terminal from the Start menu and run this again."
    exit 1
}

if (@(Get-Process shu-desktop -ErrorAction SilentlyContinue).Count) {
    Write-Host 'The app is running (the development one or an installed one). Quit it from the tray first, then run this again.'
    exit 1
}

$installer = Get-ChildItem (Join-Path $root 'apps\desktop\src-tauri\target\release\bundle\nsis') -Filter '*-setup.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) {
    Write-Host 'No installer yet. Build it first with: pnpm package'
    exit 1
}

New-Item -ItemType Directory -Force $data | Out-Null
$devData = Join-Path $root '.dev\data'
if (Test-Path (Join-Path $data 'shu.db')) {
    Write-Host "Keeping the data already in $data."
} elseif (Test-Path (Join-Path $devData 'shu.db')) {
    foreach ($item in @('shu.db', 'wechat-session.json', 'workspace')) {
        $from = Join-Path $devData $item
        if (Test-Path $from) { Copy-Item -Path $from -Destination $data -Recurse }
    }
    Write-Host "Copied the development data to $data."
}

$keys = Join-Path $data '.env.local'
$devKeys = Join-Path $root 'spikes\.env.local'
if (Test-Path $keys) {
    Write-Host 'Keeping the key file already there.'
} elseif (Test-Path $devKeys) {
    # Copied as it is. Nothing here reads what's in it.
    Copy-Item -Path $devKeys -Destination $keys
    Write-Host "Copied the key file to $keys."
} else {
    Write-Host "No key file found. Put one at $keys, or the bot can't reply."
}

Write-Host "Installing $($installer.Name) ..."
$setup = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
if ($setup.ExitCode -ne 0 -or -not (Test-Path $program)) {
    Write-Host "The installer didn't finish (exit code $($setup.ExitCode))."
    exit 1
}
Write-Host "Installed to $(Split-Path -Parent $program). Starting it."
Start-Process -FilePath $program
