import {readFile,stat,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {cleanEnvironment,verify,run,powershell} from './core.mjs';
export async function peImports(file){const b=await readFile(file);const pe=b.readUInt32LE(0x3c);if(b.toString('ascii',0,2)!=='MZ'||b.readUInt32LE(pe)!==0x4550||b.readUInt16LE(pe+4)!==0x8664)throw Error('Windows AMD64 PE required: '+file);const n=b.readUInt16LE(pe+6),optional=pe+24;if(b.readUInt16LE(optional)!==0x20b)throw Error('PE32+ required');const sections=optional+b.readUInt16LE(pe+20);const rva=r=>{for(let i=0;i<n;i++){const s=sections+40*i,va=b.readUInt32LE(s+12),size=Math.max(b.readUInt32LE(s+8),b.readUInt32LE(s+16));if(r>=va&&r<va+size)return b.readUInt32LE(s+20)+r-va;}throw Error('invalid PE RVA');};const importRva=b.readUInt32LE(optional+120);if(!importRva)return [];const dll=[];for(let p=rva(importRva),i=0;i<4096;i++,p+=20){const name=b.readUInt32LE(p+12);if(!name)return dll;const start=rva(name);const end=b.indexOf(0,start);if(end<start||end-start>512)throw Error('invalid PE import');dll.push(b.toString('ascii',start,end));}throw Error('too many PE imports');}
export async function staticPe(file){const imports=await peImports(file);if(imports.some(n=>/^(vcruntime|msvcp|concrt|msvcr)/i.test(n)))throw Error('Human package must use static MSVC CRT: '+file);return imports;}
export function environment(release,component,{probe=false}={}){const env=cleanEnvironment(process.env,{probe});if(component==='touch'){const pathKeys=Object.keys(env).filter(k=>k.toUpperCase()==='PATH');const inheritedPath=pathKeys.length?env[pathKeys[0]]:'';for(const key of pathKeys)delete env[key];env.PATH=path.dirname(powershell)+';'+path.join(process.env.SystemRoot??'C:/Windows','System32')+';'+inheritedPath;env.DESKTOP_TOUCH_MCP_HOME=path.join(release,'home');env.DOTNET_ROOT_X64=path.join(release,'dotnet');env.DOTNET_ROOT=env.DOTNET_ROOT_X64;env.DOTNET_MULTILEVEL_LOOKUP='0';if(probe)env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_PATH=path.join(release,'mutable','probe-diagnostics.jsonl');}return env;}
export async function prerequisites(release,c){for(const f of c==='human'?['node/node.exe','app/server.mjs','app/node_modules/@modelcontextprotocol/sdk/package.json','app/bin/human-input-worker.exe']:['node/node.exe','package/bin/launcher.js','dotnet/dotnet.exe','dotnet/shared/Microsoft.NETCore.App/10.0.13/Microsoft.NETCore.App.deps.json','dotnet/shared/Microsoft.WindowsDesktop.App/10.0.13/Microsoft.WindowsDesktop.App.deps.json']){try{await stat(path.join(release,f));}catch{throw Error('Missing bundled runtime/file '+f+'. Restore a complete verified portable bundle; no system Node/compiler is used.');}}
 await peImports(path.join(release,'node/node.exe'));
 if(c==='human')await staticPe(path.join(release,'app/bin/human-input-worker.exe'));
 else for(const name of ['vcruntime140.dll','vcruntime140_1.dll','msvcp140.dll']){try{await peImports(path.join(process.env.SystemRoot??'C:/Windows','System32',name));}catch{throw Error('Original Touch requires Microsoft Visual C++ x64 v14 runtime. Install from https://aka.ms/vc14/vc_redist.x64.exe (https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170), then retry. Missing/incompatible '+name);}}
}

function probeSupervisor() {
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const parent=path.basename(path.dirname(fileURLToPath(import.meta.url)));
  const sourceTree=path.basename(path.dirname(path.dirname(fileURLToPath(import.meta.url))))==='scripts' && parent==='portable';
  return path.join(root,sourceTree?'native/target/portable/x86_64-pc-windows-msvc/release/portable-supervisor.exe':'manager/portable-supervisor.exe');
}
function cleanupUnconfirmed(child,reason,diagnostics) {
  const error=Error('Readonly child failed or subtree cleanup is unconfirmed: '+reason+'. No running worker was terminated. '+diagnostics.slice(-4000));
  error.code='cleanup_unconfirmed';
  error.cleanup={tracking:'windows-job',supervisorPid:child.pid,completed:false,reason};
  return error;
}
async function finishSubtree(child,exited,timeout,report,diagnostics) {
  child.stdin.end();
  let timer;
  const ended=await Promise.race([
    exited,
    new Promise(resolve=>{timer=setTimeout(()=>resolve(null),timeout);}),
  ]);
  clearTimeout(timer);
  if(!ended)throw cleanupUnconfirmed(child,'probe subtree deadline exceeded',diagnostics());
  // Exit zero is emitted by the trusted supervisor only after Job accounting
  // proves zero active descendants and the probe root itself exited zero.
  // Any other supervisor outcome lacks that success proof, so retain staging.
  if(ended.error||ended.code!==0)throw cleanupUnconfirmed(child,'probe supervisor did not certify successful subtree completion',diagnostics());
  report.subtree={tracking:'windows-job',supervisorPid:child.pid,completed:true,exitCode:0};
  report.gracefulExit=true;
  report.exitCode=0;
}
export async function protocolProbe(command,args,env,{
  native=false,expectedVersion,timeout=60000,cleanupTimeout=15000,captureTree=false,
  managedRoot=process.env.HUMAN_PORTABLE_ROOT,component='human',supervisor=probeSupervisor(),
}={}) {
  if(!managedRoot)throw Error('A managed root is required for tracked readonly probes');
  if(native&&typeof expectedVersion!=='string')throw Error('Verified manifest product version is required for a native probe');
  const child=spawn(supervisor,[path.resolve(managedRoot),component,'probe',command,...args],{
    env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],
  });
  let buffer='',diagnostics='',next=1,failure;
  const pending=new Map();
  const report={processId:child.pid,processRole:'probe-supervisor'};
  const rejectPending=error=>{for(const item of pending.values())item.reject(error);pending.clear();};
  const exited=new Promise(resolve=>{
    child.once('exit',code=>{rejectPending(Error('readonly probe subtree exited before response'));resolve({code});});
    child.once('error',error=>{failure=error;rejectPending(error);resolve({code:null,error});});
  });
  child.stdin.on('error',error=>{failure=error;rejectPending(error);});
  child.stderr.on('data',chunk=>{diagnostics=(diagnostics+chunk).slice(-256*1024);});
  child.stdout.on('data',chunk=>{
    buffer+=chunk;
    if(buffer.length>8*1024*1024){failure=Error('probe output limit');rejectPending(failure);child.stdin.end();return;}
    let index;
    while((index=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
      try{
        const value=JSON.parse(line),item=pending.get(value.id);
        if(item){pending.delete(value.id);if(value.error||value.ok===false)item.reject(Error(JSON.stringify(value.error)));else item.resolve(native?value.result??value:value.result);}
      }catch(error){failure=error;rejectPending(error);}
    }
  });
  const request=(method,params)=>new Promise((resolve,reject)=>{
    const id=next++;pending.set(id,{resolve,reject});
    child.stdin.write(JSON.stringify(native?{id,command:method,...params}:{jsonrpc:'2.0',id,method,params})+'\n');
  });
  let timer;
  try{
    return await Promise.race([
      (async()=>{
        if(native){
          const hello=await request('hello',{});
          if(hello.protocol!==2||hello.version!==expectedVersion||hello.platform!=='windows'||!hello.capabilities||typeof hello.capabilities!=='object'||Array.isArray(hello.capabilities))throw Error('worker protocol/version mismatch');
          return Object.assign(report,{protocol:hello.protocol,version:hello.version,platform:hello.platform});
        }
        const init=await request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'portable-readonly-check',version:'1'}});
        if(component==='human'&&expectedVersion!==undefined&&(init.serverInfo?.name!=='human-input-mcp'||init.serverInfo?.version!==expectedVersion))throw Error('MCP server identity/version mismatch');
        child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
        const listed=await request('tools/list',{});
        if(!Array.isArray(listed.tools)||!listed.tools.length)throw Error('empty tool list');
        if(component==='human'&&expectedVersion!==undefined){
          if(init.protocolVersion!=='2024-11-05')throw Error('MCP protocol mismatch');
          // Public shape permits 20 digits; this value cannot be a Windows HWND.
          // The expected native refusal proves the app's real lazy WorkerClient
          // completed its own hello checks, without admitting any input work.
          const checked=await request('tools/call',{name:'human_observe',arguments:{hwnd:'18446744073709551616'}});
          let refusal;
          try{if(checked?.content?.length===1&&checked.content[0].type==='text')refusal=JSON.parse(checked.content[0].text)?.error;}catch{}
          if(checked?.isError!==true||refusal?.code!=='invalid_hwnd'||typeof refusal.message!=='string')throw Error('Human readonly worker path failed: '+(refusal?.code??'malformed_or_unexpected_result'));
          report.workerPath={tool:'human_observe',error:'invalid_hwnd',inputAdmitted:false};
        }
        if(captureTree){
          const trayDeadline=Date.now()+5000;
          while(!diagnostics.includes('[tray] System tray icon active')&&!diagnostics.includes('[tray] Tray process error:')&&Date.now()<trayDeadline)await new Promise(resolve=>setTimeout(resolve,100));
          report.trayDiagnostics=diagnostics.split(/\r?\n/).filter(line=>line.startsWith('[tray]'));
          const snapshot=await run(powershell,['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./child-snapshot.ps1',import.meta.url)),String(child.pid)],{windowsHide:true,timeout:5000});
          report.descendants=JSON.parse(snapshot.stdout);
        }
        return Object.assign(report,{server:init.serverInfo,tools:listed.tools.length});
      })(),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('readonly handshake deadline')),timeout);}),
    ]);
  }finally{
    clearTimeout(timer);
    await finishSubtree(child,exited,cleanupTimeout,report,()=>diagnostics);
    if(failure)throw Error('Readonly child failed: '+failure.message+' '+diagnostics.slice(-4000));
  }
}
export async function smoke(release,c,{
  managedRoot=process.env.HUMAN_PORTABLE_ROOT??path.resolve(release,'../..'),
  supervisor=probeSupervisor(),
}={}) {
  const manifest=await verify(release,c);
  if(c==='human'&&manifest.protocol!==2)throw Error('Unsupported Human manifest protocol');
  await prerequisites(release,c);
  const env=environment(release,c,{probe:true});
  if(c==='touch')await mkdir(path.join(release,'mutable'),{recursive:true});
  const node=path.join(release,'node/node.exe');
  const entry=path.join(release,c==='human'?'app/server.mjs':'package/bin/launcher.js');
  const tracking={managedRoot,component:c,supervisor};
  const result=await protocolProbe(node,[entry],env,{...tracking,captureTree:c==='touch',...(c==='human'?{expectedVersion:manifest.version}:{})});
  if(c==='human')result.worker=await protocolProbe(path.join(release,'app/bin/human-input-worker.exe'),[],env,{...tracking,native:true,expectedVersion:manifest.version});
  return result;
}
