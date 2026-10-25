param([Parameter(Mandatory=$true)][string]$Source,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Source)) -ne [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Destination))) { throw 'Atomic selector must remain in same directory' }
if ([IO.File]::Exists($Destination)) { [IO.File]::Replace($Source,$Destination,[System.Management.Automation.Language.NullString]::Value,$true) } else { [IO.File]::Move($Source,$Destination) }
