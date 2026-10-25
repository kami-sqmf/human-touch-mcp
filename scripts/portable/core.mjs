import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,readdir,lstat,mkdir,rename,open} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export function run(command,args,options={}){return new Promise((resolve,reject)=>{const child=execFile(command,args,options,(error,stdout,stderr)=>{if(error){error.stdout=stdout;error.stderr=stderr;reject(error);}else resolve({stdout,stderr});});child.stdin?.end();});}
export const powershell=path.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
export const componentName=c=>{if(!['human','touch'].includes(c))throw Error('component must be human or touch');return c;};
export function contained(root,target){const rel=path.relative(path.resolve(root),path.resolve(target));if(!rel||rel.startsWith('..')||path.isAbsolute(rel))throw Error('path outside managed root');return path.resolve(target);}
export function validateNames(names){
 if(names.length>30000)throw Error('unsafe archive entry count');const seen=new Map();
 for(const name of names){if(typeof name!=='string'||name.length>240||/[\\:\x00-\x1f]/.test(name)||name.startsWith('/')||name.includes('//'))throw Error('unsafe archive path');
 const parts=name.replace(/\/$/,'').split('/');if(parts.some(s=>!s||s==='.'||s==='..'||/[. ]$/.test(s)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)))throw Error('unsafe Windows archive path');
 const key=parts.join('/').toLowerCase();if(seen.has(key))throw Error('archive case collision');seen.set(key,name.endsWith('/'));
 }
 for(const key of seen.keys()){const p=key.split('/');for(let i=1;i<p.length;i++)if(seen.get(p.slice(0,i).join('/'))===false)throw Error('archive file ancestor conflict');}
 return names;
}
export async function noLinks(target){const resolved=path.resolve(target);let cur=path.parse(resolved).root;for(const part of resolved.slice(cur.length).split(path.sep)){cur=path.join(cur,part);try{const s=await lstat(cur);if(s.isSymbolicLink())throw Error('reparse/symlink path rejected');}catch(e){if(e.code!=='ENOENT')throw e;}}return resolved;}
export async function files(root){await noLinks(root);const result=[];async function walk(dir,rel=''){for(const entry of await readdir(dir,{withFileTypes:true})){const name=rel+entry.name;const full=path.join(dir,entry.name);const st=await lstat(full);if(st.isSymbolicLink())throw Error('reparse/symlink payload rejected');if(st.isDirectory())await walk(full,name+'/');else if(st.isFile())result.push(name);else throw Error('unsupported payload file');}}await walk(root);return result.sort();}
export async function hash(file,algorithm='sha256'){const h=createHash(algorithm);for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
const mutable=name=>name==='home/current.json'||name.startsWith('mutable/');
export async function seal(root,metadata){const hashes={};for(const f of await files(root))if(f!=='manifest.json'&&!mutable(f))hashes[f]=await hash(path.join(root,f));const m={schema:1,manager:1,...metadata,files:hashes};await writeFile(path.join(root,'manifest.json'),JSON.stringify(m,null,2)+'\n');return m;}
export async function verify(root,expected){
 await noLinks(root);const raw=await readFile(path.join(root,'manifest.json'));if(raw.length>8*1024*1024)throw Error('manifest too large');const m=JSON.parse(raw);
 if(m.schema!==1||m.manager!==1||m.platform!=='win32'||m.arch!=='x64'||!['human','touch'].includes(m.component)||expected&&m.component!==expected||!/^\d+\.\d+\.\d+/.test(m.version)||!m.files||Object.keys(m.files).length>30000)throw Error('unsupported release manifest');
 validateNames(Object.keys(m.files));for(const [f,h]of Object.entries(m.files))if(!/^[a-f0-9]{64}$/.test(h)||mutable(f)||f==='manifest.json')throw Error('unsafe manifest hash/path');
 const actual=(await files(root)).filter(f=>f!=='manifest.json'&&!mutable(f));if(JSON.stringify(actual)!==JSON.stringify(Object.keys(m.files).sort()))throw Error('manifest exact file set mismatch');
 let total=0;for(const f of actual){const full=path.join(root,f);total+=(await lstat(full)).size;if(total>3*1024**3)throw Error('expanded payload too large');if(await hash(full)!==m.files[f])throw Error('file hash mismatch: '+f);}
 return m;
}
export async function selection(root,component){componentName(component);await noLinks(path.join(root,'state'));try{const s=JSON.parse(await readFile(path.join(root,'state',component+'.json'),'utf8'));if(s.schema!==1||!Number.isSafeInteger(s.generation)||![s.current,s.previous].every(x=>x===null||/^[a-f0-9-]{36}$/.test(x))||s.current===null)throw Error('invalid selection');return s;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export function releasePath(root,c,id){componentName(c);if(!/^[a-f0-9-]{36}$/.test(id))throw Error('invalid release id');return contained(root,path.join(root,'versions',c,id));}
export async function atomicJson(dest,data){await noLinks(dest);await mkdir(path.dirname(dest),{recursive:true});const temp=dest+'.'+randomUUID()+'.tmp';const fd=await open(temp,'wx');try{await fd.writeFile(JSON.stringify(data,null,2)+'\n');await fd.sync();}finally{await fd.close();}
 if(process.platform==='win32'){await run(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./atomic.ps1',import.meta.url)),temp,dest],{windowsHide:true});}else await rename(temp,dest);
}
export async function promote(root,c,stage){componentName(c);await noLinks(root);contained(root,stage);await verify(stage,c);const old=await selection(root,c);const id=randomUUID();const dest=releasePath(root,c,id);await noLinks(path.dirname(dest));await mkdir(path.dirname(dest),{recursive:true});await rename(stage,dest);const next={schema:1,generation:(old?.generation??0)+1,current:id,previous:old?.current??null};await atomicJson(path.join(root,'state',c+'.json'),next);return next;}
export async function rollback(root,c){const old=await selection(root,c);if(!old?.previous)throw Error('no previous release');await verify(releasePath(root,c,old.previous),c);const next={schema:1,generation:old.generation+1,current:old.previous,previous:old.current};await atomicJson(path.join(root,'state',c+'.json'),next);return next;}
export function cleanEnvironment(source=process.env,{probe=false}={}){const env={...source};for(const k of Object.keys(env))if(/^(NODE_OPTIONS|NODE_PATH|HUMAN_INPUT_WORKER|DOTNET_ROOT.*|DOTNET_STARTUP_HOOKS|DOTNET_ADDITIONAL_DEPS|DOTNET_SHARED_STORE|DOTNET_ROLL_FORWARD.*|CORECLR_.*|COR_.*|DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED|DESKTOP_TOUCH_MCP_OFFLINE_FALLBACK)$/i.test(k)||probe&&/^(DESKTOP_TOUCH_DOCK_|DESKTOP_TOUCH_DOGFOOD|DESKTOP_TOUCH_AIM_PROBE)/i.test(k))delete env[k];if(probe)env.DESKTOP_TOUCH_MEMORY_PERSIST='0';return env;}
