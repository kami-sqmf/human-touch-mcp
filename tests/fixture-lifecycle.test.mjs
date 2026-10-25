import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {waitFor} from '../scripts/fixture/runtime.mjs';
import {Fixture} from '../scripts/fixture/runtime.mjs';

test('Fixture.launch executes the real PowerShell preflight sentinel without UI', {timeout:15000}, async()=>{
  const directory=await mkdtemp(join(tmpdir(),'human-fixture-launch-'));
  const root=fileURLToPath(new URL('../',import.meta.url));
  const fixture=new Fixture({root,directory,nonce:'0123456789abcdef',
    spawn:(command,args,options)=>spawn(command,[...args.map(value=>value==='Normal'?'Hidden':value),'-Preflight'],
      {...options,windowsHide:true,stdio:options.stdio.map((value,index)=>index===1?'pipe':value)})});
  fixture.launch();
  let output='';fixture.child.stdout.on('data',b=>{output+=b;});
  const result=await fixture.exit;
  assert.equal(result.code,0,fixture.diagnostics);
  assert.match(output,/DPI awareness established; no UI created and no clipboard accessed\./,
    'PowerShell exit 0 alone does not prove the script executed');
  assert.ok(Number.isInteger(fixture.pid),'run-bound helper PID was not authenticated');
  assert.notEqual(fixture.pid,fixture.child.pid,'relay PID must not be used as the PowerShell PID');
});

test('real Windows PowerShell timer atomically refreshes state and ACK repeatedly without UI', {timeout:15000}, async()=>{
  const directory=await mkdtemp(join(tmpdir(),'human-fixture-lifecycle-'));
  const script=fileURLToPath(new URL('../scripts/fixture/lifecycle-check.ps1',import.meta.url));
  const child=spawn('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',script,'-Directory',directory],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let diagnostic='';child.stderr.on('data',data=>{diagnostic=(diagnostic+data).slice(-4096);});
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  assert.equal(exit,0,diagnostic);
  assert.deepEqual(JSON.parse(await readFile(join(directory,'snapshot.json'),'utf8')),{shown:false,sequence:3});
  assert.deepEqual(JSON.parse(await readFile(join(directory,'ack.json'),'utf8')),{ok:true,id:3});
});

test('every unsuccessful close retains real no-UI PowerShell after outer Node exit and pipe closure', {timeout:25000}, async t=>{
  const script=fileURLToPath(new URL('./helpers/fixture-retention.mjs',import.meta.url));
  for(const [mode,expectedError] of [['command_timeout',/fixture command close/],['ack_refused',/close refused/],['exit_timeout',/graceful fixture process exit/]]) {
    const directory=await mkdtemp(join(tmpdir(),'human-fixture-retention-'));
    const started=performance.now();
    const outer=spawn(process.execPath,[script,directory,mode],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='',errors='';outer.stdout.on('data',b=>{output+=b;});outer.stderr.on('data',b=>{errors+=b;});
    const code=await new Promise((resolve,reject)=>{outer.once('error',reject);outer.once('exit',resolve);});
    assert.equal(code,0,errors);
    const elapsed=performance.now()-started;
    const record=JSON.parse(output.trim());
    assert.ok(elapsed<2500,`Node harness remained referenced for ${elapsed} ms`);
    assert.equal(record.retained,true);
    assert.equal(record.authenticatedPid,record.pid,'private relay channel must authenticate actual PowerShell PID');
    assert.notEqual(record.relayPid,record.pid);
    assert.match(record.error,expectedError);
    assert.throws(()=>process.kill(outer.pid,0),error=>error.code==='ESRCH','outer Node PID must be gone');
    assert.doesNotThrow(()=>process.kill(record.pid,0),'retained child must remain alive after outer Node exits');
    await waitFor(async()=>{try{await access(join(directory,'finished'));return true;}catch{return false;}},'natural retained child exit',4000);
    await waitFor(()=>{try{process.kill(record.pid,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}},'retained PID natural exit',2000);
    await waitFor(()=>{try{process.kill(record.relayPid,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}},'relay natural exit',2000);
    t.diagnostic(`${mode}: outer PID ${outer.pid} gone in ${Math.round(elapsed)} ms; child PID ${record.pid} proved alive after outer exit, then naturally exited`);
  }
});
