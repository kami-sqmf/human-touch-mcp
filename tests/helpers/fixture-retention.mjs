import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Fixture,waitFor} from '../../scripts/fixture/runtime.mjs';

const directory=process.argv[2];
const mode=process.argv[3];
await mkdir(join(directory,'scripts'));
// Real PowerShell, no WinForms or clipboard. Every mode exits on a bounded clock.
await writeFile(join(directory,'scripts/test-window.ps1'),`
param([string]$StatePath,[string]$Nonce)
$ErrorActionPreference='Stop'
$directory=Split-Path -Parent $StatePath
$clock=[Diagnostics.Stopwatch]::StartNew()
[IO.File]::WriteAllText((Join-Path $directory 'started'),[string]$PID)
while($clock.ElapsedMilliseconds -lt 3500) {
  [Console]::Error.WriteLine('bounded PowerShell helper alive')
  [Console]::Out.WriteLine('bounded PowerShell helper alive')
  $command=Join-Path $directory 'command.json'
  if('${mode}' -ne 'command_timeout' -and (Test-Path -LiteralPath $command)) {
    $c=Get-Content -LiteralPath $command -Raw | ConvertFrom-Json
    $ack=Join-Path $directory 'ack.json'
    $temporary=$ack+'.tmp'
    [IO.File]::WriteAllText($temporary,(@{nonce=$c.nonce;id=$c.id;ok=('${mode}' -eq 'exit_timeout')} | ConvertTo-Json -Compress))
    Move-Item -LiteralPath $temporary -Destination $ack -Force
  }
  Start-Sleep -Milliseconds 50
}
[IO.File]::WriteAllText((Join-Path $directory 'finished'),'natural PowerShell exit')
`);
const fixture=new Fixture({root:directory,directory,nonce:'0123456789abcdef',commandTimeout:700,closeTimeout:150,
  spawn:(command,args,options)=>spawn(command,args.map(value=>value==='Normal'?'Hidden':value),{...options,windowsHide:true})});
fixture.launch();
await waitFor(()=>existsSync(join(directory,'started')),'no-UI PowerShell start');
try {await fixture.close();throw new Error('Expected close timeout');}
catch(error){process.stdout.write(JSON.stringify({pid:Number(await readFile(join(directory,'started'),'utf8')),authenticatedPid:fixture.pid,
  relayPid:fixture.child.pid,error:error.message,retained:fixture.retained===true})+'\n');}
