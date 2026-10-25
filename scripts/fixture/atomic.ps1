function Write-AtomicJson($Path, $Value) {
    $temporary = $Path + '.tmp'
    [System.IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 16 -Compress))
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        try {
            if ([System.IO.File]::Exists($Path)) { [System.IO.File]::Replace($temporary, $Path, [System.Management.Automation.Language.NullString]::Value, $true) }
            else { [System.IO.File]::Move($temporary, $Path) }
            return
        } catch [System.IO.IOException] { if ($attempt -eq 4) { throw }; Start-Sleep -Milliseconds 2 }
    }
}
