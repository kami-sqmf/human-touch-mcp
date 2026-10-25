// Rust fake-platform tests pipe actual serialized runtime receipts here. No OS input.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {HumanService} from '../../lib/service.mjs';
import {validateNativeEvents} from '../../lib/events.mjs';
import {validateOperationResult} from '../../lib/native-results.mjs';

const wire=JSON.parse(readFileSync(0,'utf8'));
if(wire.kind==='exhaustion'){
  let after=0;
  for(const page of wire.pages){validateNativeEvents(page,after);after=page.next_seq;}
  validateOperationResult('status',wire.status,'op');
  assert.equal(wire.status.state,'cancelled');assert.equal(wire.status.reason,'pause_limit');
  assert.equal(wire.status.pause_revision,64);assert.equal(wire.status.cleanup_confirmed,true);
  assert.equal(wire.pages.flatMap(p=>p.records).at(-1).event,'terminal');
}else{
  let operationId,attempts=0,status=wire.paused;
  const worker={async request(command,fields){
    if(command==='observe')return {snapshot_id:'s',target_id:'t',ready:true,client:{x:0,y:0,width:1000,height:1000},cursor:{x:10,y:10}};
    if(command==='start'){operationId=fields.operation_id;return {operation_id:operationId,state:'running'};}
    if(command==='events')return {records:[],next_seq:fields.after_seq,oldest_seq:1,overflow:false};
    if(command==='resume'){
      if(++attempts===1){status=wire.rejected;throw Object.assign(new Error(wire.error.message),wire.error,{native_rejection:true,native_command:'resume',native_operation_id:operationId});}
      status=wire.finished;
    }
    return {...status,operation_id:operationId};
  }};
  const service=new HumanService({worker});await service.call('human_mode',{enabled:true});
  await service.call('reading_start',{hwnd:'1',segments:[{region_id:'a',rect:{x:10,y:10,width:20,height:20},purpose:'contract test',direction:'top_to_bottom',duration_ms:100}]});
  const args={operation_id:operationId,pause_revision:wire.paused.pause_revision,external_checked:true,resolution:{type:'finish',outcomes:[]}};
  await assert.rejects(service.call('human_resume',args),{code:wire.error.code});assert.equal(service.poisoned,false);
  if(wire.kind==='stale_resume'){
    assert.equal(attempts,1,'refusal never auto-resumes');
    await assert.rejects(service.call('human_resume',args),{code:'stale_pause_revision'});
    assert.equal(attempts,1,'old caller revision must not be dispatched again');
    const refreshed=await service.call('human_status',{operation_id:operationId});
    assert.equal(refreshed.state,'paused');assert.equal(refreshed.cleanup_confirmed,true);
    assert.equal(refreshed.pause_revision,2);
    args.pause_revision=refreshed.pause_revision;
  }
  assert.equal((await service.call('human_resume',args)).state,'completed');assert.equal(attempts,2);
}
