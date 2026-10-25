param([string]$StatePath,[string]$Nonce,[switch]$CompileOnly,[switch]$Preflight)
$ErrorActionPreference = 'Stop'
# PowerShell 5's legacy framework target otherwise disables multiline Ctrl+A.
# Set this process-local compatibility option before the first Forms use.
[AppContext]::SetSwitch('Switch.System.Windows.Forms.DoNotSupportSelectAllShortcutInMultilineTextBox',$false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot 'fixture/Receiver.cs') -ReferencedAssemblies System.Windows.Forms,System.Drawing
if ($CompileOnly) { Write-Output 'Fixture compiled; no UI created and no clipboard accessed.'; exit 0 }
if (-not $Preflight -and (-not $StatePath -or $Nonce -notmatch '^[a-f0-9]{16}$')) { throw 'StatePath and run-bound 16-hex nonce required' }
if (-not [HumanFixture.Native]::SetProcessDpiAwarenessContext([IntPtr](-4))) {
    throw 'Could not establish per-monitor v2 DPI awareness; no fixture was created'
}
if ($Preflight) { Write-Output 'DPI awareness established; no UI created and no clipboard accessed.'; exit 0 }
$session = New-Object HumanFixture.Session($Nonce)
$runDirectory = Split-Path -Parent $StatePath
$commandPath = Join-Path $runDirectory 'command.json'
$ackPath = Join-Path $runDirectory 'ack.json'
$script:lastCommand = 0
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 40
. (Join-Path $PSScriptRoot 'fixture/atomic.ps1')
$timer.Add_Tick({
    try {
        if (Test-Path -LiteralPath $commandPath) {
            $command = Get-Content -LiteralPath $commandPath -Raw | ConvertFrom-Json
            if ($command.nonce -ne $Nonce) { throw 'Command nonce mismatch' }
            if ($command.id -gt $script:lastCommand) {
                $script:lastCommand = $command.id
                $ok = $true
                switch ($command.action) {
                    'phase' { $session.Phase = $command.phase; $session.Instruction.Text = $command.instruction }
                    'clipboard_prepare' { $ok = $session.Clipboard.Prepare($session.Receiver.Handle, [bool]$command.allow_discard) }
                    'clipboard_check' { $ok = $session.Clipboard.Check() }
                    'clipboard_accept_write' { $ok = $session.Clipboard.AcceptOwnWrite([uint32]$command.before, ('clip-' + $Nonce), $session.Receiver.Handle) }
                    'clipboard_restore' { $ok = $session.Clipboard.Restore($session.Receiver.Handle) }
                    'close' { if ($session.Clipboard.Active) { $ok = $false } else { Write-AtomicJson $StatePath $session.Snapshot(); $session.Close() } }
                    default { throw 'Unknown lifecycle command' }
                }
                Write-AtomicJson $ackPath @{nonce=$Nonce;id=$command.id;ok=$ok;clipboard=$session.Clipboard.State}
            }
        }
        if (-not $session.Closing) { Write-AtomicJson $StatePath $session.Snapshot() }
        if ($session.Clock.Elapsed.TotalMinutes -gt 20) {
            $session.Watchdog = $true
            if ($session.Clipboard.Active) { [void]$session.Clipboard.Restore($session.Receiver.Handle) }
            $session.Close()
        }
    } catch {
        $session.CommandError = $_.Exception.GetType().Name
        if (-not $session.Closing) { Write-AtomicJson $StatePath $session.Snapshot() }
        # Keep lifecycle commands available for safe cleanup after a failed case.
    }
})
try {
    $session.Parking.Show()
    $timer.Start()
    # Not ShowDialog: a modal receiver would disable the parking window.
    [System.Windows.Forms.Application]::Run($session.Receiver)
} finally {
    $timer.Stop()
    if ($session.Clipboard.Active) { [void]$session.Clipboard.Restore($session.Receiver.Handle) }
    if (-not $session.Closing) { Write-AtomicJson $StatePath $session.Snapshot() }
    $timer.Dispose()
    $session.Dispose()
}
