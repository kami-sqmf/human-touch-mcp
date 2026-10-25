param([int]$RootPid)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$all=@(Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId,Name,CreationDate)
$ids=New-Object 'System.Collections.Generic.HashSet[int]';[void]$ids.Add($RootPid)
do{$changed=$false;foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)){$changed=$true}}}while($changed)
ConvertTo-Json -InputObject @($all|Where-Object {$ids.Contains([int]$_.ProcessId)}) -Compress
