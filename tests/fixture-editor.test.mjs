import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('fixture startup enables framework multiline Ctrl+A without intercepting other commands', {timeout:15000}, async t=>{
  const script=fileURLToPath(new URL('./helpers/editor-check.ps1',import.meta.url));
  const child=spawn('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(code,0,output);
  assert.match(output,/Fixture compiled;/,'actual fixture startup must execute');
  assert.match(output,/selection_start=0; selection_length=6; handle_created=False/);
  assert.match(output,/Editor command regression passed; no HWND/,'exit zero alone is insufficient');
  t.diagnostic(output.trim());
});
