// Read-only wire verification: no valid desktop input target is ever supplied.
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {WorkerClient} from '../lib/worker-client.mjs';
import {validateNativeEvents} from '../lib/events.mjs';

const client = new Client({name:'human-input-integration',version:'0.2.0'},{capabilities:{}});
const transport = new StdioClientTransport({
  command:process.execPath,
  args:[fileURLToPath(new URL('../server.mjs',import.meta.url))],
  env:{...process.env},stderr:'pipe',
});
let errors = '';
transport.stderr?.on('data', chunk => { errors += chunk.toString(); });
const timer = setTimeout(()=>{process.stderr.write('Integration deadline exceeded\n');process.exit(1);},30000);
timer.unref();
const call=async(name,args={})=>{
  const response=await client.callTool({name,arguments:args});
  const t=response.content?.find(x=>x.type==='text')?.text;
  let value;try{value=JSON.parse(t);}catch{value=t;}
  return {response,value};
};
try {
  await client.connect(transport);
  const {tools}=await client.listTools();
  const names=tools.map(x=>x.name);
  for(const required of ['human_scroll','human_key','human_copy','human_cut','human_paste','human_activate','human_pause','human_resume','human_status','human_events','human_event_ack','human_capabilities','human_mode','human_observe','human_target_update','human_input_plan','human_mouse_move','human_mouse_click','human_mouse_drag','human_type','human_stop','reading_start','reading_status','reading_cancel','timer_attach','timer_prepare','timer_calibrate','timer_status','timer_invalidate','timer_detach'])assert.ok(names.includes(required),required);
  assert.ok(names.every(x=>!/(focus_window|screenshot|clipboard|browser_)/.test(x)));
  const capabilities=await call('human_capabilities');assert.ok(!capabilities.response.isError);
  assert.match(JSON.stringify(capabilities.value),/cancel_on_user_message/);assert.equal(capabilities.value.protocol,2);assert.equal(capabilities.value.version,'0.2.0');assert.equal(capabilities.value.agent_push_supported,false);
  const mode=await call('human_mode');assert.equal(mode.value.enabled,false);
  const preview=await call('human_input_plan',{kind:'typing',text:'Hello MCP',seed:42});
  assert.ok(!preview.response.isError,JSON.stringify(preview.value));
  const blocked=await call('human_mouse_move',{hwnd:'1',x:10,y:10});assert.equal(blocked.response.isError,true);
  const stop=await call('human_stop');assert.ok(!stop.response.isError);
  const invalidTarget=await call('human_observe',{hwnd:'1'});
  assert.equal(invalidTarget.response.isError,true,'invalid target rejected by real native worker');
  assert.equal(invalidTarget.value.error?.code??invalidTarget.value.code,'target_changed',JSON.stringify(invalidTarget.value));
  const native=new WorkerClient();
  try{
    assert.equal((await native.start()).protocol,2);
    assert.deepEqual(await native.request('cancel',{}),{state:'idle'});
    await assert.rejects(native.request('start',{operation_id:'never-admitted-readonly-start',snapshot_id:'missing-readonly-snapshot',kind:'move',duration_ms:100,events:[{type:'move',x:0,y:0,at_ms:0}]}),error=>{
      assert.equal(error.code,'unknown_snapshot');assert.equal(error.native_rejection,true);assert.equal(error.native_command,'start');assert.equal(error.native_operation_id,'never-admitted-readonly-start');return true;
    });
    assert.deepEqual(await native.request('cancel',{operation_id:'never-admitted-readonly-start'}),{state:'idle'});
    await assert.rejects(native.request('status',{operation_id:'not-admitted-readonly-probe'}),{code:'unknown_operation'});
    validateNativeEvents(await native.request('events',{after_seq:0,limit:32}),0);
  }finally{await native.close();}
  const attached=await call('timer_attach',{target_id:'test-target',section_id:'test-section'});
  assert.ok(!attached.response.isError,JSON.stringify(attached.value));
  const timerId=attached.value.timer_id;
  const ticket=await call('timer_prepare',{timer_id:timerId});assert.ok(!ticket.response.isError);
  const calibrated=await call('timer_calibrate',{timer_id:timerId,ticket_id:ticket.value.ticket_id,observed_seconds:120});
  assert.ok(!calibrated.response.isError,JSON.stringify(calibrated.value));
  const status=await call('timer_status',{timer_id:timerId});assert.ok(!status.response.isError);
  assert.equal(status.value.state,'running');
  const detached=await call('timer_detach',{timer_id:timerId});assert.ok(!detached.response.isError);
  console.log(JSON.stringify({ok:true,toolCount:names.length,modeDefaultOff:true,planning:true,timer:true,blockedInput:true,nativeHandshakeAndInvalidTarget:true,nativeIdleCancelAndUnknownStatus:true,nativeProvedStartRejection:true,desktopInputInjected:false},null,2));
} finally {
  clearTimeout(timer);
  await client.close();
  if(errors.trim())process.stderr.write(errors);
}
