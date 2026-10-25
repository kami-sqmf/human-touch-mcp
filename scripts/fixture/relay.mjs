// Detached Node survives the harness; attached PowerShell runs in this relay's
// lifetime/job. Keep the relay alive until PowerShell naturally closes.
import {spawn} from 'node:child_process';

const [nonce,command,...args]=process.argv.slice(2);
function notify(message) {
  if (process.connected) {
    try { process.send({nonce,...message},()=>{}); } catch { /* Harness already left. */ }
  }
}
// The outer harness may close its pipes while the helper retains clipboard state.
// A broken diagnostic pipe must never end the helper's owning process.
for (const stream of [process.stdout,process.stderr]) stream.on('error',()=>{});
function forward(source,destination) {
  source.on('data',chunk=>{ if (!destination.destroyed) destination.write(chunk,()=>{}); });
}
const child=spawn(command,args,{detached:false,windowsHide:false,stdio:['ignore','pipe','pipe']});
forward(child.stdout,process.stdout);
forward(child.stderr,process.stderr);
child.once('spawn',()=>notify({type:'started',pid:child.pid}));
child.once('error',error=>{notify({type:'spawn_error',message:error.message});process.exitCode=1;});
child.once('exit',(code,signal)=>{notify({type:'exited',code,signal});process.exitCode=code??1;});
child.once('close',()=>{if(process.connected)process.disconnect();});
