import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,readFile,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateNames,seal,verify,selection,promote,rollback,contained,cleanEnvironment} from '../scripts/portable/core.mjs';
const temp=()=>mkdtemp(path.join(os.tmpdir(),'portable 測試 '));
test('archive prevalidation rejects Windows escape/device/collision/ancestor conflicts',()=>{
 for(const names of [['../x'],['/x'],['C:/x'],['a:stream'],['a\\b'],['aux.txt'],['a.'],['A','a'],['a','a/b'],['a//b'],['a/../b']])assert.throws(()=>validateNames(names),/unsafe|collision|ancestor/);
 assert.deepEqual(validateNames(['app/','app/index.mjs']),['app/','app/index.mjs']);
});
test('manifest seals exact bytes and rejects tampering, extra files and links',async()=>{
 const root=await temp();await writeFile(path.join(root,'a'),'ok');await seal(root,{component:'human',version:'0.2.0',arch:'x64',platform:'win32',node:'24.22.1',source:{kind:'test'}});assert.equal((await verify(root)).version,'0.2.0');
 await writeFile(path.join(root,'a'),'bad');await assert.rejects(verify(root),/hash/);await writeFile(path.join(root,'a'),'ok');await writeFile(path.join(root,'extra'),'x');await assert.rejects(verify(root),/file set/);
});
test('promotion uses fresh immutable IDs, failed verification keeps selection, rollback exchanges previous',async()=>{
 const root=await temp();await mkdir(path.join(root,'state'));await mkdir(path.join(root,'versions','human'),{recursive:true});
 const make=async(text)=>{const stage=await mkdtemp(path.join(root,'stage-'));await writeFile(path.join(stage,'a'),text);await seal(stage,{component:'human',version:'0.2.0',arch:'x64',platform:'win32',node:'24.22.1',source:{kind:'test'}});return stage;};
 const a=await promote(root,'human',await make('a'));const b=await promote(root,'human',await make('b'));assert.notEqual(a.current,b.current);assert.equal(b.previous,a.current);
 const broken=await make('c');await writeFile(path.join(broken,'a'),'corrupt');await assert.rejects(promote(root,'human',broken),/hash/);assert.equal((await selection(root,'human')).current,b.current);
 const back=await rollback(root,'human');assert.equal(back.current,a.current);assert.equal(back.previous,b.current);
});
test('containment and environment reject outside paths and injected execution hooks',async()=>{
 const root=await temp();assert.throws(()=>contained(root,path.join(root,'..','escape')),/outside/);
 const env=cleanEnvironment({PATH:'x',NODE_OPTIONS:'--require evil',NODE_PATH:'evil',HUMAN_INPUT_WORKER:'evil',DOTNET_STARTUP_HOOKS:'evil',DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED:'1',DESKTOP_TOUCH_DOCK_TITLE:'secret'});
 for(const key of ['NODE_OPTIONS','NODE_PATH','HUMAN_INPUT_WORKER','DOTNET_STARTUP_HOOKS','DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED'])assert.equal(env[key],undefined);
 assert.equal(env.DESKTOP_TOUCH_DOCK_TITLE,'secret','normal launch preserves original docking features');
});
test('manifest refuses directory junction escape and unknown manager schema',async()=>{
 const root=await temp();const outside=await temp();await writeFile(path.join(outside,'secret'),'x');await symlink(outside,path.join(root,'link'),'junction');await assert.rejects(seal(root,{component:'human'}),/reparse|symlink/);
 const clean=await temp();await writeFile(path.join(clean,'a'),'ok');await seal(clean,{component:'human',version:'0.2.0',arch:'x64',platform:'win32',node:'24.22.1'});const m=JSON.parse(await readFile(path.join(clean,'manifest.json'),'utf8'));m.manager=2;await writeFile(path.join(clean,'manifest.json'),JSON.stringify(m));await assert.rejects(verify(clean),/unsupported/);
});
test('interrupted staging and pending selector writes never become selected',async()=>{
 const root=await temp();await mkdir(path.join(root,'state'));const stage=path.join(root,'staging','ready');await mkdir(stage,{recursive:true});await writeFile(path.join(stage,'a'),'old');await seal(stage,{component:'human',version:'0.2.0',arch:'x64',platform:'win32',node:'24.22.1'});const current=await promote(root,'human',stage);await mkdir(path.join(root,'staging','interrupted'));await writeFile(path.join(root,'state','human.json.interrupted.tmp'),'{truncated');assert.deepEqual(await selection(root,'human'),current);assert.throws(()=>validateNames(Array.from({length:30001},(_,i)=>'f'+i)),/count/);
});
test('original Touch resolves built-in PowerShell with a PATH that contains no Node',async()=>{const {environment}=await import('../scripts/portable/probe.mjs');const prior=process.env.PATH;try{process.env.PATH='C:/Windows/System32';const child=environment('C:/portable/touch','touch',{probe:true});assert.ok(String(child.PATH??child.Path??'').toLowerCase().includes('windowspowershell'),'original tray/helper PowerShell must remain available');}finally{process.env.PATH=prior;}});
