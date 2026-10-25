param([Parameter(ValueFromRemainingArguments=$true)][string[]]$ManagerArgs)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$OutputEncoding=[Console]::OutputEncoding
$root=$PSScriptRoot
$node=Join-Path $root 'runtime/node/node.exe'
$supervisor=Join-Path $root 'manager/portable-supervisor.exe'
if(-not (Test-Path -LiteralPath $node -PathType Leaf)){throw 'Bundled Node is missing. Restore the complete portable package; system Node/npm is not used.'}
if(-not (Test-Path -LiteralPath $supervisor -PathType Leaf)){throw 'Portable supervisor is missing. Restore the complete portable package.'}
foreach($key in @('NODE_OPTIONS','NODE_PATH','HUMAN_INPUT_WORKER','DOTNET_STARTUP_HOOKS','DOTNET_ADDITIONAL_DEPS','DOTNET_SHARED_STORE','CORECLR_ENABLE_PROFILING','COR_ENABLE_PROFILING')){[Environment]::SetEnvironmentVariable($key,$null,'Process')}
if(-not $ManagerArgs -or $ManagerArgs.Length -lt 2){throw 'Usage: .\launch.ps1 version|config|verify|launch|install|update|rollback human|touch [options]'}
$mode='shared';if($ManagerArgs[0] -in @('install','update','rollback')){$mode='exclusive'}
& $supervisor $root $ManagerArgs[1] $mode $node (Join-Path $root 'manager/portable.mjs') @ManagerArgs
exit $LASTEXITCODE
