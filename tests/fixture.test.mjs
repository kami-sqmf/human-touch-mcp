import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Fixture} from '../scripts/fixture/runtime.mjs';
import {validateSnapshot, validateObservation, knownTextEvidence, classifyAcceptanceError, validateCoordinateSource} from '../scripts/fixture/guards.mjs';

const rect={x:20,y:40,width:500,height:400};
const fixture=()=>({nonce:'run',pid:123,sequence:2,elapsed_ms:100,shown:true,
  receiver:{hwnd:'42',identity:'123:456',visible:true,enabled:true,window_state:'Normal',dpi:96,rect,client:rect},
  parking:{hwnd:'43',identity:'123:456',visible:true,enabled:true,window_state:'Normal',dpi:96,rect,client:rect}});
test('Fixture.read admits only the authenticated helper PID, refusing the relay PID',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'human-fixture-pid-'));
  const runtime=new Fixture({root:directory,directory,nonce:'run'});
  runtime.pid=123;runtime.child={pid:456};
  await writeFile(join(directory,'fixture.json'),JSON.stringify({...fixture(),pid:456,command_error:null}));
  await assert.rejects(runtime.read(),/Fixture process differs/);
  await writeFile(join(directory,'fixture.json'),JSON.stringify({...fixture(),command_error:null}));
  assert.equal((await runtime.read()).pid,123);
});
test('run guard refuses stale process, sequence, nonce and hidden fixture snapshots',()=>{
  const expected={nonce:'run',pid:123,after:1};
  assert.equal(validateSnapshot(fixture(),expected).sequence,2);
  for(const patch of [{nonce:'old'},{pid:999},{sequence:1},{shown:false}]) {
    assert.throws(()=>validateSnapshot({...fixture(),...patch},expected));
  }
  const hidden=fixture();hidden.receiver.visible=false;
  assert.throws(()=>validateSnapshot(hidden,expected));
});
test('physical admission rejects geometry, DPI, identity and editor-focus disagreement',()=>{
  const f=fixture().receiver;
  const o={...f,ready:true,foreground:'42',focus:'44',cursor:{x:100,y:100}};
  assert.equal(validateObservation(f,o,{focus:'44'}),o);
  for(const patch of [{identity:'123:other'},{dpi:144},{client:{...rect,x:21}},{foreground:'43'},{focus:'45'}]) {
    assert.throws(()=>validateObservation(f,{...o,...patch},{focus:'44'}));
  }
  assert.equal(validateObservation(f,{...o,foreground:'43',ready:false},{activation:true}),undefined);
});
test('receiver result comparison exposes only approved expectation and length',()=>{
  assert.deepEqual(knownTextEvidence({length:9,matches:{token:false}},'token'),{expected:'token',length:9,matches:false});
  assert.equal(JSON.stringify(knownTextEvidence({text:'foreign secret',length:14,matches:{token:false}},'token')).includes('secret'),false);
});
test('missing physical movement is inconclusive rather than a product input failure',()=>{
  assert.deepEqual(classifyAcceptanceError(new Error('Timed out: physical takeover evidence')),
    {status:'inconclusive',category:'manual_movement_not_demonstrated'});
  assert.deepEqual(classifyAcceptanceError(new Error('human_type: protocol_error')),
    {status:'failed',category:'verification_error'});
});
test('coordinate admission rejects moved window or control geometry from the point source',()=>{
  const source=fixture();source.canvas={rect:{...rect}};
  const moved=structuredClone(source);moved.receiver.rect.x+=30;moved.receiver.client.x+=30;
  assert.throws(()=>validateCoordinateSource(source,moved),/coordinate|geometry/i);
  const relaid=structuredClone(source);relaid.canvas.rect.y+=20;
  assert.throws(()=>validateCoordinateSource(source,relaid),/coordinate|geometry/i);
  assert.doesNotThrow(()=>validateCoordinateSource(source,structuredClone(source)));
  assert.throws(()=>validateCoordinateSource(undefined,source),/source/i);
});
