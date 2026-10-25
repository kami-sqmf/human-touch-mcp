#!/usr/bin/env node
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {WorkerClient} from './lib/worker-client.mjs';
import {createHumanServer} from './lib/mcp-server.mjs';

const worker=new WorkerClient();
const {service,server,connect}=createHumanServer({worker,diagnosticNotifications:process.env.HUMAN_INPUT_DIAGNOSTIC_NOTIFICATIONS==='1'});
let shuttingDown=false;
async function closeWorker() {
  try {await worker.close();}
  catch(error) {process.stderr.write(`Human worker ${error.code??'close_failed'}: ${error.message}\n`);process.exitCode=1;}
}
async function shutdown() {
  if(shuttingDown)return;shuttingDown=true;
  try{await service.call('human_stop',{reason:'server_shutdown'});}catch{}
  await closeWorker();await server.close();
}
process.once('SIGINT',()=>{void shutdown();});
process.once('SIGTERM',()=>{void shutdown();});
process.stdin.once('end',()=>{void shutdown();});
try {await connect(new StdioServerTransport());}
catch(error){process.stderr.write(`Human MCP startup failed: ${error.message}\n`);await closeWorker();process.exitCode=1;}
