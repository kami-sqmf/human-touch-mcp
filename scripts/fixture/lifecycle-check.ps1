param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
. (Join-Path $PSScriptRoot 'atomic.ps1')
$script:count=0
$script:failure=$null
$timer=New-Object System.Windows.Forms.Timer
$timer.Interval=30
$timer.Add_Tick({
    try {
        $script:count++
        Write-AtomicJson (Join-Path $Directory 'snapshot.json') @{sequence=$script:count;shown=$false}
        Write-AtomicJson (Join-Path $Directory 'ack.json') @{id=$script:count;ok=$true}
        if($script:count -ge 3){[System.Windows.Forms.Application]::ExitThread()}
    } catch {$script:failure=$_.Exception.Message;[System.Windows.Forms.Application]::ExitThread()}
})
try {$timer.Start();[System.Windows.Forms.Application]::Run()}finally{$timer.Stop();$timer.Dispose()}
if($script:failure){throw $script:failure}
