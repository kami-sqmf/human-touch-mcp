import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {LoggingMessageNotificationSchema} from '@modelcontextprotocol/sdk/types.js';
test('MCP wire exposes strict tools and synthetic diagnostic token ACK without certifying Agent receipt',async()=>{
  const {createHumanServer}=await import('../lib/mcp-server.mjs');
  const {HumanService}=await import('../lib/service.mjs');
  const service=new HumanService({worker:{request:async()=>{throw new Error('no native boundary expected');}}});
  const {server,connect}=createHumanServer({service,diagnosticNotifications:true});
  const [a,b]=InMemoryTransport.createLinkedPair();let actualSends=0,sendFault=null;const send=a.send.bind(a);a.send=async msg=>{if(msg.method==='notifications/message'){actualSends++;if(sendFault==='reject')throw new Error('synthetic disconnect');if(sendFault==='block')return new Promise(()=>{});}return send(msg);};
  const client=new Client({name:'synthetic-harness',version:'1'},{capabilities:{}});let notification;
  client.setNotificationHandler(LoggingMessageNotificationSchema,msg=>{notification=msg.params.data;});
  await connect(a);await client.connect(b);
  try{
    assert.ok((await client.listTools()).tools.some(t=>t.name==='human_event_ack'));
    const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});return {raw:r,value:JSON.parse(r.content[0].text)};};
    assert.equal((await call('human_capabilities')).value.agent_push_supported,false);
    await call('human_pause');
    const e=service.events.add({seq:1,event:'paused',pause_revision:1,operation_id:'synthetic'});
    await service.events.diagnostic(e,service.diagnosticSend);
    assert.equal(actualSends,1);assert.equal(notification.event_id,e.event_id);
    assert.equal(service.events.query({}).events[0].delivery_state,'transport_written');
    const receipt={event_id:e.event_id,session_epoch:e.session_epoch,pause_generation:e.pause_generation,receipt_token:e.receipt_token};
    const ack=await call('human_event_ack',receipt);assert.equal(ack.value.acknowledgment_scope,'mcp_caller_receipt');
    assert.equal((await call('human_status')).value.state,'paused');
    assert.equal((await call('human_key',{hwnd:'1',key:'v',modifiers:['ctrl']})).raw.isError,true);
    assert.equal((await call('human_capabilities')).value.agent_push_supported,false);
    await client.setLoggingLevel('emergency');
    const filtered=service.events.add({seq:2,event:'paused',pause_revision:2,operation_id:'synthetic'});
    await service.events.diagnostic(filtered,service.diagnosticSend);
    assert.equal(actualSends,1,'filtered helper resolution is not actual send');
    assert.equal(service.events.query({}).events[1].delivery_state,'transport_failed');
    assert.equal(service.events.query({}).events[1].transport_written_at,null);
    await client.setLoggingLevel('warning');
    for(const [seq,fault] of [[3,'reject'],[4,'block']]){
      sendFault=fault;const failed=service.events.add({seq,event:'paused',pause_revision:seq,operation_id:'synthetic'});
      await service.events.diagnostic(failed,service.diagnosticSend);
      const record=service.events.query({}).events.find(e=>e.seq===seq);assert.equal(record.delivery_state,'transport_failed');assert.equal(record.transport_written_at,null);assert.equal(record.pending,true);
    }
    assert.equal((await call('human_status')).value.state,'paused');
  }finally{await client.close();await server.close();}
});
