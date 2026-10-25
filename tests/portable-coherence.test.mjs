import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {smoke,prerequisites} from '../scripts/portable/probe.mjs';
import {seal,promote,selection,run} from '../scripts/portable/core.mjs';

const metadata={component:'human',version:'0.2.1',protocol:2,platform:'win32',arch:'x64',node:process.versions.node,source:{kind:'readonly-test-fixture'}};
const temp=()=>mkdtemp(path.join(os.tmpdir(),'human coherence '));
function pe(machine=0x8664){const b=Buffer.alloc(512);b.write('MZ');b.writeUInt32LE(0x80,0x3c);b.writeUInt32LE(0x4550,0x80);b.writeUInt16LE(machine,0x84);b.writeUInt16LE(0x20b,0x98);return b;}

test('final fix: bundled Node must be actual AMD64 PE before startup',async()=>{
  const release=await temp();
  for(const file of ['node/node.exe','app/server.mjs','app/node_modules/@modelcontextprotocol/sdk/package.json','app/bin/human-input-worker.exe']){
    await mkdir(path.dirname(path.join(release,file)),{recursive:true});await writeFile(path.join(release,file),file.endsWith('.exe')?pe():'{}');
  }
  await prerequisites(release,'human');
  await writeFile(path.join(release,'node/node.exe'),pe(0x14c));
  await assert.rejects(prerequisites(release,'human'),/Windows AMD64 PE required.*node.exe/);
});

test('final fix: sealed updates require coherent manifest MCP identity and actual WorkerClient handshake',{timeout:120000},async()=>{
  const root=await temp();
  for(const version of ['0.1.9','0.2.0']){
    const old=path.join(root,'staging',version);await mkdir(old,{recursive:true});await writeFile(path.join(old,'marker'),version);await seal(old,{...metadata,version});await promote(root,'human',old);
  }
  const before=await selection(root,'human'),stage=path.join(root,'staging/new');
  await mkdir(path.join(stage,'node'),{recursive:true});await cp(process.execPath,path.join(stage,'node/node.exe'));
  await mkdir(path.join(stage,'app/bin'),{recursive:true});await cp('server.mjs',path.join(stage,'app/server.mjs'));await cp('lib',path.join(stage,'app/lib'),{recursive:true});await cp('node_modules',path.join(stage,'app/node_modules'),{recursive:true});
  await run('rustc',['--edition=2024','--crate-name','portable_readonly_fixture','-C','target-feature=+crt-static','tests/fixtures/portable-readonly-worker.rs','-o',path.join(stage,'app/bin/human-input-worker.exe')],{windowsHide:true,timeout:30000});
  const attempt=async()=>{await seal(stage,metadata);const result=await smoke(stage,'human',{managedRoot:root});await promote(root,'human',stage);return result;};
  await assert.rejects(attempt(),/MCP server identity\/version mismatch/);assert.deepEqual(await selection(root,'human'),before);
  const bump=async relative=>{const file=path.join(stage,'app',relative);await writeFile(file,(await readFile(file,'utf8')).replaceAll('0.2.0','0.2.1'));};
  await bump('lib/mcp-server.mjs');await bump('lib/service.mjs');
  await assert.rejects(attempt(),/readonly worker path.*protocol_mismatch/);assert.deepEqual(await selection(root,'human'),before);
  await bump('lib/worker-client.mjs');
  const serverFile=path.join(stage,'app/lib/mcp-server.mjs'),correctServer=await readFile(serverFile,'utf8');
  await writeFile(serverFile,correctServer.replace("name:'human-input-mcp'","name:'wrong-server'"));
  await assert.rejects(attempt(),/MCP server identity\/version mismatch/);assert.deepEqual(await selection(root,'human'),before);
  await writeFile(serverFile,correctServer);
  await seal(stage,{...metadata,protocol:3});await assert.rejects(smoke(stage,'human',{managedRoot:root}),/manifest protocol/);assert.deepEqual(await selection(root,'human'),before);
  const result=await attempt();assert.equal(result.server.version,'0.2.1');assert.equal(result.worker.version,'0.2.1');assert.equal(result.worker.protocol,2);assert.equal(result.workerPath.error,'invalid_hwnd');assert.equal(result.subtree.completed,true);assert.equal(result.worker.subtree.completed,true);
  const selected=await selection(root,'human');assert.equal(selected.previous,before.current);assert.notEqual(selected.current,before.current);
});
