param([string]$Destination)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
if(-not $Destination){$Destination=Join-Path $projectRoot 'work/releases'}
$node=Join-Path $projectRoot 'work/prerequisites/node-v24.22.1-win-x64/node.exe'
if(-not (Test-Path -LiteralPath $node -PathType Leaf)){throw 'Prepare the verified Node 24.22.1 distribution in work/prerequisites first (see docs/PORTABLE.md).'}
if((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'd702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5'){throw 'Build Node hash mismatch'}
foreach($key in @('NODE_OPTIONS','NODE_PATH','HUMAN_INPUT_WORKER')){[Environment]::SetEnvironmentVariable($key,$null,'Process')}
& $node (Join-Path $PSScriptRoot 'portable/build-package.mjs') $Destination
if($LASTEXITCODE -ne 0){throw 'Portable package build failed'}
