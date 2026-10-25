import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {HumanService} from './service.mjs';
import {TOOLS,toolError} from './tools.mjs';

/** The optional 2025 log path is diagnostics only, never model push certification. */
export function createHumanServer({worker,service=new HumanService({worker}),diagnosticNotifications=false}={}){
  const server=new Server({name:'human-input-mcp',version:'0.2.0'},{capabilities:{tools:{},...(diagnosticNotifications?{logging:{}}:{})}});
  let protocolVersion=null;
  const attempts=new Map();
  if(diagnosticNotifications)service.diagnosticSend=async event=>{
    if(protocolVersion!=='2025-11-25')throw toolError('diagnostic_protocol_unsupported','Diagnostic logs are enabled only for negotiated MCP 2025-11-25');
    // The SDK helper can resolve after filtering without sending. Only the
    // instrumented transport primitive can establish a written receipt.
    let deadline;const attempt={written:false};attempts.set(event.event_id,attempt);
    try{await Promise.race([server.sendLoggingMessage({level:'warning',logger:'human-input-safety-diagnostic',data:event}),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(toolError('diagnostic_timeout','Diagnostic transport send exceeded 1000 ms')),1000);})]);if(!attempt.written)throw toolError('diagnostic_not_sent','Diagnostic notification was filtered or not written');}
    finally{clearTimeout(deadline);attempts.delete(event.event_id);}
  };
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:TOOLS}));
  server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
    try{
      const result=await service.call(request.params.name,request.params.arguments??{},extra.signal);
      return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,...(result.state==='failed'?{isError:true}:{})};
    }catch(error){return {isError:true,content:[{type:'text',text:JSON.stringify({error:{code:error.code??'operation_failed',message:error.message}})}]};}
  });
  const connect=async transport=>{
    const send=transport.send.bind(transport);
    transport.send=async(message,options)=>{await send(message,options);if(message.result?.protocolVersion)protocolVersion=message.result.protocolVersion;if(message.method==='notifications/message'&&message.params?.logger==='human-input-safety-diagnostic'){const attempt=attempts.get(message.params.data?.event_id);if(attempt)attempt.written=true;}};
    return server.connect(transport);
  };
  return {server,service,connect};
}
