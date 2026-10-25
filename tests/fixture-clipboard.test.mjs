import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('native snapshot seam distinguishes empty completion from enumeration failures without real clipboard access', {timeout:15000}, async()=>{
  const script=fileURLToPath(new URL('./helpers/clipboard-check.ps1',import.meta.url));
  const receiver=fileURLToPath(new URL('../scripts/fixture/Receiver.cs',import.meta.url));
  const child=spawn('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',script,'-Receiver',receiver],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  assert.equal(code,0,output);
  assert.match(output,/no windows or real clipboard API calls/);
});
