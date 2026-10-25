param([Parameter(Mandatory=$true)][string]$Receiver)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Path @($Receiver,(Join-Path $PSScriptRoot 'ClipboardSnapshotTests.cs')) -ReferencedAssemblies System.Windows.Forms,System.Drawing
[ClipboardSnapshotTests]::Run()
Write-Output 'Clipboard snapshot seam passed; no windows or real clipboard API calls.'
