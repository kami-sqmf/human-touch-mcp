import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import {spawn as spawnChild} from 'node:child_process';
import {WorkerClient} from '../lib/worker-client.mjs';
import {nativeStatus} from './helpers/native-fixtures.mjs';
function harness({protocol=2,requestTimeoutMs=500,gracefulExit=true}={}) { const child=new EventEmitter(); child.stdout=new PassThrough(); child.stderr=new PassThrough(); child.killed=false; child.kill=()=>{child.killed=true;child.emit('exit',1,null);return true}; const requests=[]; child.stdin=new Writable({write(chunk,_encoding,done){for(const line of chunk.toString().trim().split('\n')){const req=JSON.parse(line);requests.push(req); if(req.command==='hello') queueMicrotask(()=>reply(req,{protocol,version:'0.2.0',platform:'windows',capabilities:{}})); if(req.command==='ping') queueMicrotask(()=>reply(req,{alive:true}));} done();}});if(gracefulExit)child.stdin.on('finish',()=>queueMicrotask(()=>child.emit('exit',0,null))); function reply(req,result){child.stdout.write(JSON.stringify({id:req.id,ok:true,result})+'\n')} const client=new WorkerClient({spawn:()=>child,executable:'C:\\fixture\\human-input-worker.exe',pingIntervalMs:100000,requestTimeoutMs}); return {client,child,requests,reply}; }
const tick=()=>new Promise(r=>setImmediate(r));
test('fix2: only a matched exact native rejection envelope receives admission provenance',async()=>{
  const h=harness();const p=h.client.request('start',{operation_id:'expected'});await tick();const req=h.requests.find(r=>r.command==='start');h.child.stdout.write(JSON.stringify({id:req.id,ok:false,error:{code:'input_busy',message:'busy before admission'}})+'\n');await assert.rejects(p,error=>{assert.equal(error.code,'input_busy');assert.equal(error.native_rejection,true);assert.equal(error.native_command,'start');assert.equal(error.native_operation_id,'expected');return true;});assert.equal(h.client.closed,false);await h.client.close();
  const bad=harness();const malformed=bad.client.request('start',{operation_id:'expected'});await tick();const badReq=bad.requests.find(r=>r.command==='start');bad.child.stdout.write(JSON.stringify({id:badReq.id,ok:false,error:{code:'input_busy',message:'busy',extra:'not exact'}})+'\n');await assert.rejects(malformed,{code:'protocol_error'});await bad.client.close();
});
test('review: operation replies bind identity and validate complete exact status progress',async()=>{
  const malformed=[
    nativeStatus('different-operation','paused',{cleanup_confirmed:false,progress:{source_units_total:-1}}),
    nativeStatus('different-operation'),
    {operation_id:'expected-operation',state:'cancelled'},
    nativeStatus('expected-operation','paused',{cleanup_confirmed:undefined}),
    nativeStatus('expected-operation','paused',{progress:{source_units_total:-1}}),
    nativeStatus('expected-operation','paused',{unexpected:true}),
    nativeStatus('expected-operation','paused',{progress:{...nativeStatus('x').progress,journal:[{frame_id:0}],journal_frames_total:1}}),
    nativeStatus('expected-operation','paused',{trajectory:{observed_ms:1,sample_count:300,range_px:1,path_px:1,motion_span_ms:0,stable_for_ms:1}})
  ];
  for(const command of ['status','pause','resume','cancel'])for(const result of malformed){
    const h=harness();const p=h.client.request(command,{operation_id:'expected-operation'});await tick();h.reply(h.requests.find(r=>r.command===command),result);
    await assert.rejects(p,{code:'protocol_error'});assert.equal(h.client.closed,true);await h.client.close();assert.equal(h.child.killed,false);
  }
});
test('review: minimal start and idle cancel remain exact command-specific variants',async()=>{
  for(const result of [{state:'running'},{operation_id:'wrong',state:'running'},{operation_id:'expected',state:'running',cleanup_confirmed:true}]){const h=harness();const p=h.client.request('start',{operation_id:'expected'});await tick();h.reply(h.requests.find(r=>r.command==='start'),result);await assert.rejects(p,{code:'protocol_error'});await h.client.close();}
  const h=harness();const p=h.client.request('start',{operation_id:'expected'});await tick();h.reply(h.requests.find(r=>r.command==='start'),{operation_id:'expected',state:'running'});assert.equal((await p).state,'running');const c=h.client.request('cancel');await tick();h.reply(h.requests.find(r=>r.command==='cancel'),{state:'idle'});assert.deepEqual(await c,{state:'idle'});await h.client.close();
});
test('review: complete documented native journal status survives the transport without invented cleanup proof',async()=>{
  const status=nativeStatus('op-1','paused',{elapsed_ms:120,injected_events:2,resume_requirement:'resolve_uncertain_effects',remaining_budget_ms:80,progress:{source_units_total:1,source_units_complete:0,plan_events_inserted:1,cleanup_events_inserted:1,uncertain_unit_ids:['u0'],remaining_frames:0,journal:[{frame_id:0,unit_id:'u0',revision:0,disposition:'uncertain',primary:true,sent:true,original_at_ms:0,external_outcome:null,gesture_id:null},{frame_id:1,unit_id:'u0',revision:0,disposition:'satisfied_by_cleanup',primary:false,sent:false,original_at_ms:40,external_outcome:null,gesture_id:null}],journal_frames_total:2,journal_truncated:false,external_outcomes:[]},reason:'keyboard_state_changed',error:{code:'keyboard_state_changed',message:'Keyboard state changed'},inputInjected:true});
  const h=harness();const p=h.client.request('status',{operation_id:'op-1'});await tick();h.reply(h.requests.find(r=>r.command==='status'),status);assert.deepEqual(await p,status);await h.client.close();
});
test('valid JSON with an unknown operation state fails closed',async()=>{const h=harness();const p=h.client.request('status',{operation_id:'a'});await tick();h.reply(h.requests.find(r=>r.command==='status'),{state:'made_up'});await assert.rejects(p,{code:'protocol_error'});await h.client.close();assert.equal(h.child.killed,false);});
test('hello protocol mismatch closes stdin for cleanup and rejects request',async()=>{const h=harness({protocol:1}); await assert.rejects(h.client.request('observe',{hwnd:'1'}),{code:'protocol_mismatch'});await h.client.close();assert.equal(h.child.stdin.writableEnded,true);assert.equal(h.child.killed,false);});
test('cancel dispatches while an earlier start response is pending',async()=>{const h=harness(); const start=h.client.request('start',{operation_id:'op'}); await tick(); const cancel=h.client.request('cancel',{operation_id:'op'}); await tick(); const req=h.requests.find(x=>x.command==='cancel'); assert.ok(req); h.reply(req,nativeStatus('op','cancelled')); assert.equal((await cancel).state,'cancelled'); h.reply(h.requests.find(x=>x.command==='start'),{operation_id:'op',state:'running'}); await start; await h.client.close();});
test('out of order responses match IDs and carry worker errors',async()=>{const h=harness(); const a=h.client.request('status',{operation_id:'a'}); const b=h.client.request('status',{operation_id:'b'}); await tick(); const requests=h.requests.filter(x=>x.command==='status'); h.reply(requests[1],nativeStatus('b','completed')); h.child.stdout.write(JSON.stringify({id:requests[0].id,ok:false,error:{code:'unknown_operation',message:'unknown'}})+'\n'); assert.equal((await b).state,'completed'); await assert.rejects(a,{code:'unknown_operation'}); await h.client.close();});
test('worker exit invalidates every outstanding request without restart',async()=>{const h=harness();const p=h.client.request('status',{operation_id:'a'});await tick();h.child.emit('exit',3,null);await assert.rejects(p,{code:'worker_closed'});await assert.rejects(h.client.request('ping'),{code:'worker_closed'});});
test('oversized IPC line closes the worker before parsing',async()=>{const h=harness();const p=h.client.request('status',{operation_id:'a'});await tick();h.child.stdout.write('a'.repeat(2*1024*1024+1));await assert.rejects(p,{code:'protocol_error'});await h.client.close();assert.equal(h.child.stdin.writableEnded,true);assert.equal(h.child.killed,false);});
test('malformed response fails closed and request deadline cannot restart',async()=>{const h=harness();const p=h.client.request('status',{operation_id:'a'});await tick();h.child.stdout.write('{broken}\n');await assert.rejects(p,{code:'protocol_error'});await assert.rejects(h.client.request('ping'),{code:'worker_closed'});});
test('cancellation has reserved admission when 56 requests are pending',async()=>{const h=harness();await h.client.start();const pending=Array.from({length:56},(_,i)=>h.client.request('status',{operation_id:String(i)}));const settled=Promise.allSettled(pending);await tick();const cancel=h.client.request('cancel',{});await tick();const request=h.requests.find(x=>x.command==='cancel');assert.ok(request);h.reply(request,{state:'idle'});await cancel;await h.client.close();await settled;});
test('request deadline closes without restart and preserves graceful cleanup',async()=>{const h=harness({requestTimeoutMs:20});await assert.rejects(h.client.request('status',{operation_id:'a'}),{code:'worker_timeout'});await h.client.close();assert.equal(h.child.killed,false);await assert.rejects(h.client.request('ping'),{code:'worker_closed'});});
test('lease ping remains available at saturation without closing the worker',async()=>{const h=harness();await h.client.start();const pending=Array.from({length:56},(_,i)=>h.client.request('status',{operation_id:String(i)}));const settled=Promise.allSettled(pending);await tick();assert.equal((await h.client.request('ping')).alive,true);assert.equal(h.client.closed,false);await h.client.close();await settled;});
test('unproven cleanup reports a deterministic error and detaches without killing',async()=>{const h=harness({gracefulExit:false});const detached=[];h.child.unref=()=>detached.push('child');for(const name of ['stdin','stdout','stderr'])h.child[name].unref=()=>detached.push(name);await h.client.start();const closed=h.client.close();assert.equal(h.child.stdin.writableEnded,true);assert.equal(h.child.killed,false);await assert.rejects(closed,{code:'cleanup_unconfirmed'});assert.equal(h.child.killed,false);assert.deepEqual(detached.sort(),['child','stderr','stdin','stdout']);await assert.rejects(h.client.close(),{code:'cleanup_unconfirmed'});await assert.rejects(h.client.request('ping'),{code:'worker_closed'});assert.equal(h.client.pending.size,0);});
test('detached real child and pipes retain no referenced Node handles',async()=>{
  // A Node-only fixture simulates slow cleanup, then exits itself; no native input.
  const fixture=`let buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\\n'))>=0){const request=JSON.parse(buffer.slice(0,index));buffer=buffer.slice(index+1);const result=request.command==='hello'?{protocol:2,version:'0.2.0',platform:'windows',capabilities:{}}:{alive:true};process.stdout.write(JSON.stringify({id:request.id,ok:true,result})+'\\n');}});process.stdin.on('end',()=>setTimeout(()=>process.exit(0),4000));`;
  let child;
  const client=new WorkerClient({executable:process.execPath,spawn:(_exe,_args,options)=>{child=spawnChild(process.execPath,['-e',fixture],options);return child;}});
  await client.start();
  await assert.rejects(client.close(),{code:'cleanup_unconfirmed'});
  assert.equal(child.killed,false);
  assert.equal(child.exitCode,null);
  assert.equal(child._handle.hasRef(),false);
  for(const stream of [child.stdin,child.stdout,child.stderr])if(stream._handle)assert.equal(stream._handle.hasRef(),false);
});
