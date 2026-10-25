import {toolError} from './tools.mjs';

const states=['running','pausing','paused','resuming','cancelling','completed','cancelled','failed'];
const own=(value,required,optional=[])=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k));
const uint=(n,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(n)&&n>=0&&n<=max;
const finite=n=>Number.isFinite(n)&&n>=0;
const id=s=>typeof s==='string'&&Buffer.byteLength(s)>0&&Buffer.byteLength(s)<=128&&!/[\p{Cc}]/u.test(s);
const unit=s=>id(s)&&/^u[0-9]+$/.test(s);
const outcome=s=>['applied','not_applied','unknown'].includes(s);
const fault=f=>own(f,['code','message'])&&typeof f.code==='string'&&typeof f.message==='string';
const trajectory=t=>t===null||(own(t,['observed_ms','sample_count','range_px','path_px','motion_span_ms','stable_for_ms'])&&uint(t.observed_ms,3000)&&uint(t.sample_count,256)&&finite(t.range_px)&&finite(t.path_px)&&uint(t.motion_span_ms)&&uint(t.stable_for_ms));

function progress(p){
  const counters=['source_units_total','source_units_complete','plan_events_inserted','cleanup_events_inserted','remaining_frames','journal_frames_total'];
  if(!own(p,[...counters,'uncertain_unit_ids','journal','journal_truncated','external_outcomes'])||!counters.every(k=>uint(p[k]))||p.source_units_complete>p.source_units_total||p.journal_frames_total>60000||p.remaining_frames>p.journal_frames_total||typeof p.journal_truncated!=='boolean')return false;
  if(!Array.isArray(p.uncertain_unit_ids)||p.uncertain_unit_ids.length>p.source_units_total||!p.uncertain_unit_ids.every(unit)||new Set(p.uncertain_unit_ids).size!==p.uncertain_unit_ids.length)return false;
  if(!Array.isArray(p.journal)||p.journal.length!==Math.min(p.journal_frames_total,256)||p.journal_truncated!==(p.journal_frames_total>256))return false;
  let previous=-1;
  for(const e of p.journal){
    if(!own(e,['frame_id','unit_id','revision','disposition','primary','sent','original_at_ms','external_outcome','gesture_id'])||!uint(e.frame_id)||e.frame_id<=previous||e.frame_id>=p.journal_frames_total||!unit(e.unit_id)||!uint(e.revision,64)||!['unsent','inserted','satisfied_by_cleanup','superseded_motion','uncertain','externally_resolved'].includes(e.disposition)||typeof e.primary!=='boolean'||typeof e.sent!=='boolean'||!finite(e.original_at_ms)||!(e.external_outcome===null||outcome(e.external_outcome))||!(e.gesture_id===null||id(e.gesture_id)))return false;
    previous=e.frame_id;
  }
  return Array.isArray(p.external_outcomes)&&p.external_outcomes.length<=60000&&p.external_outcomes.every(e=>own(e,['unit_id','outcome','pause_revision'])&&unit(e.unit_id)&&outcome(e.outcome)&&uint(e.pause_revision,64));
}

/** Exact protocol-2 operation variants, shared by transport and service barriers. */
export function validateOperationResult(command,result,operation_id){
  const fail=()=>{throw toolError('protocol_error',`Malformed or mismatched native ${command} result`);};
  if(command==='start'){
    if(!own(result,['operation_id','state'])||!id(result.operation_id)||result.operation_id!==operation_id||result.state!=='running')fail();
    return result;
  }
  if(command==='cancel'&&result?.state==='idle'){
    if(!own(result,['state']))fail();
    return result;
  }
  const keys=['operation_id','state','elapsed_ms','injected_events','pause_revision','pause_mode','trajectory','resume_requirement','remaining_budget_ms','progress','cleanup_confirmed','foreground_observed','inputInjected','deliveryVerified'];
  if(!own(result,keys,['reason','error'])||!id(result.operation_id)||(operation_id!==undefined&&operation_id!==null&&result.operation_id!==operation_id)||!states.includes(result.state)||!uint(result.elapsed_ms)||!uint(result.injected_events)||!uint(result.pause_revision,64)||![null,'sampling','manual'].includes(result.pause_mode)||!trajectory(result.trajectory)||![null,'fresh_external_observation','resolve_uncertain_effects','remaining_gesture_or_finish'].includes(result.resume_requirement)||!finite(result.remaining_budget_ms)||!progress(result.progress)||typeof result.cleanup_confirmed!=='boolean'||![null,true,false].includes(result.foreground_observed)||typeof result.inputInjected!=='boolean'||result.deliveryVerified!==false||(Object.hasOwn(result,'reason')&&typeof result.reason!=='string')||(Object.hasOwn(result,'error')&&!fault(result.error)))fail();
  return result;
}
