param([Parameter(Mandatory=$true)][string]$Root,[ValidateSet('human','touch')][string]$Component='human')
$ErrorActionPreference='Stop'
$portableRoot=(Resolve-Path -LiteralPath $Root).Path
& (Join-Path $portableRoot 'launch.ps1') config $Component
exit $LASTEXITCODE
