import {createWriteStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {Readable,Transform} from 'node:stream';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {run,powershell,hash,validateNames,noLinks} from './core.mjs';
export const zipScript=fileURLToPath(new URL('./zip.ps1',import.meta.url));
export async function zip(mode,archive,destination){const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',zipScript,mode,archive];if(destination)args.push(destination);const r=await run(powershell,args,{windowsHide:true,maxBuffer:12*1024*1024});return mode==='list'?JSON.parse(r.stdout.replace(/^\uFEFF/,'')):r;}
export async function extract(archive,stage,expected){if(!/^[a-f0-9]{64}$/i.test(expected??''))throw Error('trusted expected SHA256 required');if((await stat(archive)).size>1024**3)throw Error('archive too large');if(await hash(archive)!==expected.toLowerCase())throw Error('archive SHA256 mismatch');await noLinks(stage);const entries=await zip('list',archive);validateNames(entries.map(e=>e.name));await zip('extract',archive,stage);}
export async function download(url,destination,{limit=1024**3,timeout=120000}={}){let next=new URL(url);const abort=AbortSignal.timeout(timeout);for(let i=0;i<6;i++){if(next.protocol!=='https:')throw Error('HTTPS required for code downloads');const response=await fetch(next,{redirect:'manual',signal:abort});if(response.status>=300&&response.status<400){next=new URL(response.headers.get('location'),next);continue;}if(!response.ok)throw Error('download HTTP '+response.status);if(Number(response.headers.get('content-length')??0)>limit)throw Error('download too large');let total=0;await pipeline(Readable.fromWeb(response.body),new Transform({transform(c,_,cb){total+=c.length;cb(total>limit?Error('download byte limit'):null,c);}}),createWriteStream(destination,{flags:'wx'}));return destination;}throw Error('too many redirects');}
