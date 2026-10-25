param([Parameter(Mandatory=$true)][ValidateSet('list','extract','create')][string]$Mode,[Parameter(Mandatory=$true)][string]$Archive,[string]$Destination)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
function LongPath([string]$p) { $p=[IO.Path]::GetFullPath($p); if($p.StartsWith('\\?\')){return $p}; return '\\?\'+$p }
if($Mode -eq 'create'){
 $source=LongPath $Destination
 $created=[IO.Compression.ZipFile]::Open((LongPath $Archive),[IO.Compression.ZipArchiveMode]::Create)
 try {
  function Add-ArchiveDirectory([string]$Directory,[string]$Relative){
   if(([IO.File]::GetAttributes($Directory) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'reparse package source'}
   foreach($file in [IO.Directory]::EnumerateFiles($Directory)){
    if(([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'reparse package source'}
    $name=$Relative+[IO.Path]::GetFileName($file)
    $entry=$created.CreateEntry($name,[IO.Compression.CompressionLevel]::Optimal)
    $inputStream=[IO.File]::OpenRead($file);$outputStream=$entry.Open()
    try{$inputStream.CopyTo($outputStream)}finally{$inputStream.Dispose();$outputStream.Dispose()}
   }
   foreach($directory in [IO.Directory]::EnumerateDirectories($Directory)){
    $name=$Relative+[IO.Path]::GetFileName($directory)+'/'
    [void]$created.CreateEntry($name)
    Add-ArchiveDirectory $directory $name
   }
  }
  Add-ArchiveDirectory $source ''
 }finally{$created.Dispose()}
 exit
}
$zip=[IO.Compression.ZipFile]::OpenRead((LongPath $Archive))
try {
 $entries=@();$seen=@{};$total=[long]0
 if($zip.Entries.Count -gt 30000){throw 'unsafe archive entry count'}
 foreach($entry in $zip.Entries){
  $name=$entry.FullName
  if(-not $name -or $name.Length -gt 240 -or $name -match '[\\:\x00-\x1f]' -or $name.StartsWith('/') -or $name.Contains('//')){throw 'unsafe archive path'}
  $parts=$name.TrimEnd('/').Split('/')
  foreach($part in $parts){if(-not $part -or $part -in @('.','..') -or $part -match '[. ]$' -or $part -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)'){throw 'unsafe Windows archive path'}}
  $key=$name.TrimEnd('/').ToUpperInvariant();if($seen.ContainsKey($key)){throw 'archive case collision'};$seen[$key]=$name.EndsWith('/')
  $attrs=[uint32]([int64]$entry.ExternalAttributes -band 0xffffffffL)
  if(($attrs -band 0x400) -ne 0 -or (($attrs -shr 16) -band 0xf000) -eq 0xa000){throw 'archive reparse/symlink rejected'}
  $total+=$entry.Length;if($total -gt 3221225472L -or $entry.Length -gt 1073741824L){throw 'expanded archive too large'}
  $entries+=@{name=$name;size=$entry.Length}
 }
 foreach($key in @($seen.Keys)){$parts=$key.Split('/');for($i=1;$i -lt $parts.Length;$i++){$ancestor=($parts[0..($i-1)] -join '/');if($seen.ContainsKey($ancestor) -and -not $seen[$ancestor]){throw 'archive file ancestor conflict'}}}
 if($Mode -eq 'list'){ConvertTo-Json -InputObject @($entries) -Compress;exit}
 $dest=[IO.Path]::GetFullPath($Destination).TrimEnd('\')
 if([IO.Directory]::Exists($dest) -and [IO.Directory]::GetFileSystemEntries((LongPath $dest)).Length -gt 0){throw 'archive destination must be fresh and empty'}
 [IO.Directory]::CreateDirectory((LongPath $dest))|Out-Null
 foreach($entry in $zip.Entries){
  $target=[IO.Path]::GetFullPath([IO.Path]::Combine($dest,$entry.FullName.Replace('/','\')))
  if(-not $target.StartsWith($dest+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'archive outside managed stage'}
  $current=$target
  while($current){if([IO.Directory]::Exists((LongPath $current)) -or [IO.File]::Exists((LongPath $current))){if(([IO.File]::GetAttributes((LongPath $current)) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'reparse extraction path'}};$current=[IO.Path]::GetDirectoryName($current)}
  if($entry.FullName.EndsWith('/')){[IO.Directory]::CreateDirectory((LongPath $target))|Out-Null;continue}
  [IO.Directory]::CreateDirectory((LongPath ([IO.Path]::GetDirectoryName($target))))|Out-Null
  $input=$entry.Open();$output=New-Object IO.FileStream((LongPath $target),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$buffer=New-Object byte[] 65536;$copied=[long]0;while(($n=$input.Read($buffer,0,$buffer.Length)) -gt 0){$copied+=$n;if($copied -gt $entry.Length -or $copied -gt 1073741824L){throw 'expanded entry limit'};$output.Write($buffer,0,$n)};if($copied -ne $entry.Length){throw 'truncated entry'};$output.Flush($true)}finally{$input.Dispose();$output.Dispose()}
 }
}finally{$zip.Dispose()}
