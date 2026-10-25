import {randomUUID} from 'node:crypto';
import {toolError} from './tools.mjs';

/** Bounded discovery receipts. An ACK proves only an observed MCP caller request. */
export class EventStore {
  constructor(){this.session_epoch=randomUUID();this.records=[];this.seq=0;this.nativeSeq=0;this.bytes=0;this.overflow_count=0;this.native_overflow_count=0;}
  #trim(){this.bytes=this.records.reduce((n,e)=>n+Buffer.byteLength(JSON.stringify(e)),0);while(this.records.length>128||this.bytes>256*1024){this.bytes-=Buffer.byteLength(JSON.stringify(this.records.shift()));this.overflow_count++;}}
  add(native){
    if(native.seq<=this.nativeSeq)return null;
    this.nativeSeq=native.seq;
    const event={...structuredClone(native),native_seq:native.seq,seq:++this.seq,event_id:randomUUID(),session_epoch:this.session_epoch,pause_generation:native.pause_revision??0,receipt_token:randomUUID(),observed_at:new Date().toISOString(),pending:true,delivery_state:'pending',transport_attempted_at:null,transport_written_at:null,transport_error:null,acknowledged_at:null,acknowledgment_scope:null};
    this.records.push(event);this.#trim();return structuredClone(event);
  }
  query({after_seq=0,limit=128,pending_only=false}={}){return {events:structuredClone(this.records.filter(e=>e.seq>after_seq&&(!pending_only||e.pending)).slice(0,limit)),session_epoch:this.session_epoch,next_seq:this.seq,oldest_seq:this.records[0]?.seq??this.seq+1,overflow_count:this.overflow_count,native_overflow_count:this.native_overflow_count,agent_push_supported:false};}
  ack(args){const e=this.records.find(e=>e.event_id===args.event_id);if(!e||args.session_epoch!==this.session_epoch||args.pause_generation!==e.pause_generation||args.receipt_token!==e.receipt_token)throw toolError('invalid_event_receipt','Unknown, evicted, stale or mismatched event receipt');if(!e.acknowledged_at){e.acknowledged_at=new Date().toISOString();e.acknowledgment_scope='mcp_caller_receipt';e.pending=false;e.delivery_state='acknowledged';this.#trim();}return structuredClone(e);}
  async diagnostic(event,send){const e=this.records.find(e=>e.event_id===event.event_id);if(!e||e.transport_attempted_at)return;e.transport_attempted_at=new Date().toISOString();try{await send(structuredClone(e));e.transport_written_at=new Date().toISOString();if(e.pending)e.delivery_state='transport_written';}catch(error){e.transport_error=String(error.message??error).slice(0,512);if(e.pending)e.delivery_state='transport_failed';}this.#trim();}
}

const counters=['source_units_total','source_units_complete','plan_events_inserted','cleanup_events_inserted','uncertain_units_count','remaining_frames','journal_frames_total'];
const names=['started','anomaly','paused','pointer_takeover','external_observation_required','auto_resumed','resumed','resume_rejected','terminal'];
const states=['running','pausing','paused','resuming','cancelling','completed','cancelled','failed'];
const eventKeys=['seq','operation_id','event','state','pause_revision','pause_mode','trajectory','reason','elapsed_ms','progress'];
export function validateNativeEvents(result,after){
  if(!result||Object.keys(result).some(k=>!['records','next_seq','oldest_seq','overflow'].includes(k))||!Array.isArray(result.records)||result.records.length>128||!Number.isSafeInteger(result.next_seq)||result.next_seq<after||!Number.isSafeInteger(result.oldest_seq)||result.oldest_seq<0||typeof result.overflow!=='boolean')throw toolError('protocol_error','Malformed native event envelope');
  let seq=after;
  for(const e of result.records){
    const validTrajectory=e?.trajectory===null||(e?.trajectory&&Object.keys(e.trajectory).length===6&&['observed_ms','sample_count','range_px','path_px','motion_span_ms','stable_for_ms'].every(k=>Number.isFinite(e.trajectory[k])&&e.trajectory[k]>=0)&&Number.isInteger(e.trajectory.sample_count)&&e.trajectory.sample_count<=256&&e.trajectory.observed_ms<=3000);
    if(!e||Object.keys(e).length!==eventKeys.length||!eventKeys.every(k=>Object.hasOwn(e,k))||!Number.isSafeInteger(e.seq)||e.seq<=seq||!names.includes(e.event)||!states.includes(e.state)||![null,'manual','sampling'].includes(e.pause_mode)||!validTrajectory||!(e.reason===null||typeof e.reason==='string')||!Number.isFinite(e.elapsed_ms)||e.elapsed_ms<0||typeof e.operation_id!=='string'||Buffer.byteLength(e.operation_id)<1||Buffer.byteLength(e.operation_id)>128||/[\p{Cc}]/u.test(e.operation_id)||!Number.isSafeInteger(e.pause_revision)||e.pause_revision<0||e.pause_revision>64||!e.progress||Object.keys(e.progress).length!==7||!counters.every(k=>Number.isSafeInteger(e.progress[k])&&e.progress[k]>=0))throw toolError('protocol_error','Malformed native event record');
    seq=e.seq;
  }
  if(result.next_seq!==seq)throw toolError('protocol_error','Native event cursor mismatch');return result;
}
