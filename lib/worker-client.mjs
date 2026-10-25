import {spawn as spawnChild} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {toolError} from './tools.mjs';
import {validateOperationResult} from './native-results.mjs';

const MAX_LINE=2*1024*1024;
const root=fileURLToPath(new URL('../',import.meta.url));
export function workerExecutable() {
  const configured=process.env.HUMAN_INPUT_WORKER;
  if(configured) {
    if(!path.isAbsolute(configured)) throw toolError('invalid_worker_path','HUMAN_INPUT_WORKER must be an absolute executable path');
    return configured;
  }
  const candidates=[path.join(root,'bin','human-input-worker.exe'),path.join(root,'native','target','release','human-input-worker.exe')];
  return candidates.find(p=>existsSync(p))??candidates[0];
}

/** One child, many in-flight requests. Transport failure is permanent for this client. */
export class WorkerClient {
  constructor({executable,spawn=spawnChild,pingIntervalMs=500,requestTimeoutMs=3500}={}) {
    this.executable=executable;this.spawn=spawn;this.pingIntervalMs=pingIntervalMs;this.requestTimeoutMs=requestTimeoutMs;
    this.pending=new Map();this.nextId=1;this.closed=false;this.child=null;this.buffer=Buffer.alloc(0);this.ready=null;this.heartbeat=null;this.hello=null;this.exited=false;this.closePromise=null;
  }
  async start() {
    if(this.closed) throw toolError('worker_closed','Worker connection is closed');
    if(!this.ready) this.ready=this.#launch();
    return this.ready;
  }
  async #launch() {
    try {
      const executable=this.executable??workerExecutable();
      if(!path.isAbsolute(executable))throw toolError('invalid_worker_path','Worker executable must be an absolute path');
      this.child=this.spawn(executable,[],{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false,cwd:root});
      this.exitPromise=new Promise(resolve=>{this.resolveExit=resolve;});
      this.child.once('error',error=>this.#fail(toolError('worker_closed',`Worker failed: ${error.message}`)));
      this.child.once('exit',()=>{this.exited=true;this.resolveExit();this.#fail(toolError('worker_closed','Worker exited'));});
      this.child.stdout.on('data',chunk=>this.#receive(chunk));
      this.child.stdout.once('end',()=>this.#fail(toolError('worker_closed','Worker stdout ended')));
      this.child.stdout.on('error',error=>this.#fail(toolError('worker_closed',error.message)));
      this.child.stdin.on('error',error=>this.#fail(toolError('worker_closed',error.message)));
      // Drain diagnostics without retaining unbounded stderr or contaminating MCP stdout.
      this.child.stderr.on('data',chunk=>process.stderr.write(chunk));
      this.child.stderr.on('error',error=>this.#fail(toolError('worker_closed',error.message)));
      this.hello=await this.#send('hello',{});
      if(this.hello.protocol!==2||this.hello.platform!=='windows'||this.hello.version!=='0.2.0'||!this.hello.capabilities||typeof this.hello.capabilities!=='object') throw toolError('protocol_mismatch','Worker hello does not match protocol 2/version 0.2.0/windows');
      this.heartbeat=setInterval(()=>{
        if([...this.pending.values()].some(p=>p.command==='ping'))return;
        this.#send('ping',{}).then(result=>{if(result.alive!==true)this.#fail(toolError('protocol_error','Invalid ping response'));},error=>this.#fail(error));
      },this.pingIntervalMs);
      this.heartbeat.unref?.();
      return this.hello;
    } catch(error) {this.#fail(error);throw error;}
  }
  async request(command,fields={}) {
    await this.start();
    return this.#send(command,fields);
  }
  #send(command,fields) {
    if(this.closed) return Promise.reject(toolError('worker_closed','Worker connection is closed'));
    const control=['cancel','ping','pause','resume','events'].includes(command);
    const reserved=control&&![...this.pending.values()].some(p=>p.command===command);
    if((control&&!reserved)||this.pending.size>=61||this.pending.size>=56&&!reserved) return Promise.reject(toolError('ipc_busy','Worker request slots are reserved for control and lease traffic'));
    const id=this.nextId++;
    const encoded=JSON.stringify({...fields,id,command})+'\n';
    if(Buffer.byteLength(encoded)>MAX_LINE) return Promise.reject(toolError('request_too_large','Worker request exceeds 2 MiB'));
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>this.#fail(toolError('worker_timeout',`Worker command timed out: ${command}`)),this.requestTimeoutMs);
      this.pending.set(id,{resolve,reject,timeout,command,operation_id:fields.operation_id});
      try {this.child.stdin.write(encoded,error=>{if(error)this.#fail(toolError('worker_closed',error.message));});}
      catch(error){this.#fail(toolError('worker_closed',error.message));}
    });
  }
  #receive(chunk) {
    if(this.closed)return;
    this.buffer=Buffer.concat([this.buffer,chunk]);
    for(;;) {
      const end=this.buffer.indexOf(10);
      if((end<0&&this.buffer.length>MAX_LINE)||(end>MAX_LINE)) {this.#fail(toolError('protocol_error','Worker response exceeds 2 MiB'));return;}
      if(end<0)return;
      const line=this.buffer.subarray(0,end);this.buffer=this.buffer.subarray(end+1);
      try {
        const msg=JSON.parse(line.toString('utf8'));
        if(!msg||!Number.isSafeInteger(msg.id)||typeof msg.ok!=='boolean'||Object.keys(msg).some(k=>!['id','ok',msg.ok?'result':'error'].includes(k)))throw new Error('Malformed envelope');
        const pending=this.pending.get(msg.id);
        if(!pending)throw new Error('Unexpected response ID');
        if(msg.ok) {if(!msg.result||typeof msg.result!=='object'||Array.isArray(msg.result))throw new Error('Malformed result');}
        else if(!msg.error||Object.keys(msg.error).length!==2||typeof msg.error.code!=='string'||typeof msg.error.message!=='string')throw new Error('Malformed error');
        if(msg.ok&&['start','status','pause','resume','cancel'].includes(pending.command))validateOperationResult(pending.command,msg.result,pending.operation_id);
        this.pending.delete(msg.id);clearTimeout(pending.timeout);
        if(msg.ok) pending.resolve(msg.result);
        else pending.reject(Object.assign(toolError(msg.error.code,msg.error.message),{native_rejection:true,native_command:pending.command,native_operation_id:pending.operation_id}));
      } catch(error) {this.#fail(toolError('protocol_error',`Invalid worker response: ${error.message}`));return;}
    }
  }
  #fail(error) {
    if(this.closed)return;
    this.closed=true;clearInterval(this.heartbeat);
    for(const p of this.pending.values()){clearTimeout(p.timeout);p.reject(error);}
    this.pending.clear();this.buffer=Buffer.alloc(0);
    this.closePromise=this.#cleanup();
    // Transport errors may trigger cleanup before callers explicitly close. Observe
    // that background rejection while retaining it for deterministic close() errors.
    this.closePromise.catch(()=>{});
  }
  async #cleanup() {
    if(!this.child||this.exited)return;
    // EOF lets Rust unwind only its own held input and restore IME. Never interrupt
    // cleanup by killing the worker, even if confirmation exceeds our wait budget.
    try{this.child.stdin.end();}catch{}
    let deadline;
    await Promise.race([this.exitPromise,new Promise(resolve=>{deadline=setTimeout(resolve,2300);})]);
    clearTimeout(deadline);
    if(!this.exited) {
      for(const stream of [this.child.stdin,this.child.stdout,this.child.stderr]) {
        try {if(typeof stream.unref==='function')stream.unref();else stream.destroy();}catch{}
      }
      try{this.child.unref();}catch{}
      throw toolError('cleanup_unconfirmed','Worker received EOF but cleanup was not confirmed within 2300 ms; worker was detached without termination');
    }
  }
  async close() {this.#fail(toolError('worker_closed','Worker connection closed'));await this.closePromise;}
}
