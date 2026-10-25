param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$Bundle,[Parameter(Mandatory=$true)][string]$Sha256,[ValidateSet('human','touch')][string]$Component='human')
$ErrorActionPreference='Stop'
& (Join-Path (Resolve-Path -LiteralPath $Root).Path 'launch.ps1') install $Component --bundle (Resolve-Path -LiteralPath $Bundle).Path --sha256 $Sha256
exit $LASTEXITCODE
