import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {protocolProbe} from '../scripts/portable/probe.mjs';
import {seal,verify,promote,selection} from '../scripts/portable/core.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const temporary=()=>mkdtemp(path.join(os.tmpdir(),'probe 子程序 '));
const metadata={component:'human',version:'0.2.1',protocol:2,platform:'win32',arch:'x64',node:process.versions.node,source:{kind:'test'}};
async function nativeFixture(version,protocol=2){
 const root=await temporary();const stage=path.join(root,'staging/native');await mkdir(stage,{recursive:true});await writeFile(path.join(stage,'marker'),'verified');await seal(stage,metadata);const manifest=await verify(stage,'human');
 const code=`let text='';process.stdin.on('data',chunk=>{text+=chunk;let i;while((i=text.indexOf('\\n'))>=0){const request=JSON.parse(text.slice(0,i));text=text.slice(i+1);process.stdout.write(JSON.stringify({id:request.id,ok:true,result:{version:${JSON.stringify(version)},protocol:${protocol},platform:"windows",capabilities:{}}})+'\\n');}});process.stdin.on('end',()=>process.exit(0));`;
 return protocolProbe(process.execPath,['-e',code],process.env,{native:true,expectedVersion:manifest.version,managedRoot:root,component:'human',timeout:2000,cleanupTimeout:1000});
}
test('native hello accepts a compatible non-0.2.0 verified manifest product version',async()=>{const result=await nativeFixture('0.2.1');assert.equal(result.version,'0.2.1');assert.equal(result.protocol,2);});
test('native hello rejects mismatched product version and unsupported protocol',async()=>{await assert.rejects(nativeFixture('0.2.0'),/worker protocol\/version mismatch/);await assert.rejects(nativeFixture('0.2.1',3),/worker protocol\/version mismatch/);});

async function descendantFixture(childMs){
 const root=await temporary();const old=path.join(root,'staging/old');const stage=path.join(root,'staging/new');await mkdir(old,{recursive:true});await writeFile(path.join(old,'marker'),'old');await seal(old,metadata);const before=await promote(root,'human',old);await mkdir(stage);await writeFile(path.join(stage,'marker'),'new');await seal(stage,metadata);const idsFile=path.join(root,'ids.json');const brokenFile=path.join(root,'mutation-before-exit');
 const grandCode=`const fs=require('node:fs');setTimeout(()=>{if(!fs.existsSync(${JSON.stringify(path.join(stage,'marker'))}))fs.writeFileSync(${JSON.stringify(brokenFile)},'stage changed while child was alive');process.exit(0)},${childMs});`;
 const code=`const {spawn}=require('node:child_process');const fs=require('node:fs');const readline=require('node:readline');let started=false;readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(request.method==='initialize'){if(!started){started=true;const child=spawn(process.execPath,['-e',${JSON.stringify(grandCode)}],{stdio:'ignore',detached:true});child.unref();fs.writeFileSync(${JSON.stringify(idsFile)},JSON.stringify({root:process.pid,child:child.pid}));}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{serverInfo:{name:'probe-fixture',version:'0.2.1'},capabilities:{}}})+'\\n');}else if(request.method==='tools/list')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{tools:[{name:'readonly_fixture'}]}})+'\\n');});process.stdin.on('end',()=>process.exit(0));`;
 const ids=async()=>{for(let i=0;i<100;i++){try{return JSON.parse(await readFile(idsFile,'utf8'));}catch{await delay(20);}}throw Error('fixture did not start');};
 return {root,stage,before,brokenFile,code,ids};
}
test('probe subtree completes only after detached descendant exits, then promotion may occur',{timeout:6000},async()=>{
 const fixture=await descendantFixture(900);let settled=false,probeResult;const pending=protocolProbe(process.execPath,['-e',fixture.code],process.env,{managedRoot:fixture.root,component:'human',timeout:2000,cleanupTimeout:2500}).then(async result=>{settled=true;probeResult=result;return promote(fixture.root,'human',fixture.stage);});
 const ids=await fixture.ids();await delay(180);assert.throws(()=>process.kill(ids.root,0),'probe root must already be gone');assert.doesNotThrow(()=>process.kill(ids.child,0),'detached fixture child must survive');assert.equal(settled,false,'promotion boundary must not settle while child lives');assert.deepEqual(await selection(fixture.root,'human'),fixture.before);await stat(fixture.stage);
 const after=await pending;assert.equal(probeResult.subtree.completed,true);assert.equal(after.previous,fixture.before.current);assert.throws(()=>process.kill(ids.child,0));await assert.rejects(stat(fixture.brokenFile),{code:'ENOENT'});
});
test('probe cleanup deadline reports unconfirmed subtree and preserves staged files/selection until natural exit',{timeout:6000},async()=>{
 const fixture=await descendantFixture(900);const started=Date.now();const pending=protocolProbe(process.execPath,['-e',fixture.code],process.env,{managedRoot:fixture.root,component:'human',timeout:2000,cleanupTimeout:120});const rejection=assert.rejects(pending,error=>{assert.equal(error.code,'cleanup_unconfirmed');assert.equal(error.cleanup.tracking,'windows-job');assert.equal(error.cleanup.completed,false);return true;});rejection.catch(()=>{});const ids=await fixture.ids();await rejection;assert.ok(Date.now()-started<800,'probe decision is bounded');assert.doesNotThrow(()=>process.kill(ids.child,0));await stat(path.join(fixture.stage,'marker'));assert.deepEqual(await selection(fixture.root,'human'),fixture.before);await delay(1100);assert.throws(()=>process.kill(ids.child,0));await assert.rejects(stat(fixture.brokenFile),{code:'ENOENT'});
});
// End-to-end update failure path: no input worker is ever started. The dummy
// worker only supplies static PE metadata; the MCP subtree times out first.
test('cleanup_unconfirmed preserves actual manager staging while outer component lease outlives its error',{timeout:60000},async()=>{
 const {cp,readdir}=await import('node:fs/promises');
 const {spawn}=await import('node:child_process');
 const {once}=await import('node:events');
 const {zip}=await import('../scripts/portable/archive.mjs');
 const {hash,run}=await import('../scripts/portable/core.mjs');
 const root=await temporary(),manager=path.join(root,'manager');
 const supervisor=path.resolve('native/target/portable/x86_64-pc-windows-msvc/release/portable-supervisor.exe');
 await mkdir(manager);await cp('scripts/portable.mjs',path.join(manager,'portable.mjs'));await cp('scripts/portable',path.join(manager,'portable'),{recursive:true});await cp(supervisor,path.join(manager,'portable-supervisor.exe'));
 const old=path.join(root,'staging/old');await mkdir(old,{recursive:true});await writeFile(path.join(old,'marker'),'old');await seal(old,{...metadata,version:'0.2.0'});const before=await promote(root,'human',old);
 const payload=path.join(root,'payload');await mkdir(path.join(payload,'node'),{recursive:true});await cp(process.execPath,path.join(payload,'node/node.exe'));
 await mkdir(path.join(payload,'app/node_modules/@modelcontextprotocol/sdk'),{recursive:true});await writeFile(path.join(payload,'app/node_modules/@modelcontextprotocol/sdk/package.json'),'{}');await mkdir(path.join(payload,'app/bin'));
 const pe=Buffer.alloc(512);pe.write('MZ');pe.writeUInt32LE(0x80,0x3c);pe.writeUInt32LE(0x4550,0x80);pe.writeUInt16LE(0x8664,0x84);pe.writeUInt16LE(0x20b,0x98);await writeFile(path.join(payload,'app/bin/human-input-worker.exe'),pe);await writeFile(path.join(payload,'marker'),'must survive');
 const idsFile=path.join(root,'manager-fixture-ids.json');
 const code=`import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';const require=createRequire(import.meta.url);const fs=require('node:fs');const{spawn}=require('node:child_process');const readline=require('node:readline');let started=false;readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method==='initialize'){if(!started){started=true;const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),19000)'],{stdio:'ignore',detached:true});child.unref();fs.writeFileSync(${JSON.stringify(idsFile)},JSON.stringify({root:process.pid,child:child.pid,stage:fileURLToPath(new URL('../',import.meta.url))}));}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{serverInfo:{name:'manager-fixture',version:'0.2.0'},capabilities:{}}})+'\\n');}else if(r.method==='tools/list')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{tools:[{name:'readonly_fixture'}]}})+'\\n');});process.stdin.on('end',()=>process.exit(0));`;
 await writeFile(path.join(payload,'app/server.mjs'),code);await seal(payload,{...metadata,version:'0.2.0'});const archive=path.join(root,'fixture.zip');await zip('create',archive,payload);
 const child=spawn(supervisor,[root,'human','exclusive',process.execPath,path.join(manager,'portable.mjs'),'install','human','--bundle',archive,'--sha256',await hash(archive)],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stderr='',finished=false;child.stdout.resume();child.stderr.on('data',chunk=>{stderr+=chunk;});const exit=once(child,'exit').then(value=>{finished=true;return value;});
 let ids;for(let i=0;i<500;i++){try{ids=JSON.parse(await readFile(idsFile,'utf8'));break;}catch{await delay(25);}}assert.ok(ids,'actual staged probe started');
 for(let i=0;i<700&&!stderr.includes('cleanup is unconfirmed');i++)await delay(25);
 assert.match(stderr,/subtree cleanup is unconfirmed/);assert.equal(finished,false,'bounded rejection is not a claim that the outer CLI exited');assert.doesNotThrow(()=>process.kill(ids.child,0));await stat(path.join(ids.stage,'marker'));assert.deepEqual(await selection(root,'human'),before);
 await assert.rejects(run(supervisor,[root,'human','exclusive',process.execPath,'-e','0']),/busy/);
 const [codeValue]=await exit;assert.equal(codeValue,1);assert.throws(()=>process.kill(ids.child,0));await stat(path.join(ids.stage,'marker'));assert.deepEqual(await selection(root,'human'),before);assert.equal((await readdir(path.join(root,'state/jobs/human'))).length,0);
});
test('internal probe mode cannot launch a manager command without its component lease',{timeout:5000},async()=>{
 const {cp}=await import('node:fs/promises');const {run}=await import('../scripts/portable/core.mjs');const root=await temporary();const manager=path.join(root,'manager');await mkdir(manager);await cp('scripts/portable.mjs',path.join(manager,'portable.mjs'));await cp('scripts/portable',path.join(manager,'portable'),{recursive:true});
 await assert.rejects(run(path.resolve('native/target/portable/x86_64-pc-windows-msvc/release/portable-supervisor.exe'),[root,'human','probe',process.execPath,path.join(manager,'portable.mjs'),'config','human'],{windowsHide:true}),/so OS leases are held/);
});
