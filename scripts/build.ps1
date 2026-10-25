param([switch]$NoCopy)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
$savedFlags=$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS
$savedTarget=$env:CARGO_TARGET_DIR
try {
 $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS='-C target-feature=+crt-static'
 $env:CARGO_TARGET_DIR=Join-Path $projectRoot 'native/target/portable'
 & cargo build --locked --release --target x86_64-pc-windows-msvc --manifest-path (Join-Path $projectRoot 'native/Cargo.toml')
 if($LASTEXITCODE -ne 0){throw 'Static CRT Rust release build failed'}
 if(-not $NoCopy){New-Item -ItemType Directory -Path (Join-Path $projectRoot 'bin') -Force|Out-Null;foreach($name in @('human-input-worker.exe','portable-supervisor.exe')){Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR ('x86_64-pc-windows-msvc/release/'+$name)) -Destination (Join-Path $projectRoot ('bin/'+$name)) -Force}}
 Write-Output 'Static CRT Windows x64 worker and portable supervisor built. Package builder verifies PE imports.'
}finally{$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS=$savedFlags;$env:CARGO_TARGET_DIR=$savedTarget}
