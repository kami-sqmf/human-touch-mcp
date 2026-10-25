import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {toolError,validateTool} from './tools.mjs';
import {EventStore,validateNativeEvents} from './events.mjs';
import {validateOperationResult} from './native-results.mjs';

const terminal = status => ['completed','cancelled','failed'].includes(status?.state);
const mouseKinds={human_mouse_move:'move',human_mouse_click:'click',human_mouse_drag:'drag',human_type:'typing',reading_start:'reading',human_scroll:'scroll',human_key:'key',human_copy:'copy',human_cut:'cut',human_paste:'paste',human_activate:'activate'};
const within=(p,r)=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=r.x&&p.y>=r.y&&p.x<r.x+r.width&&p.y<r.y+r.height;
const rejectedByNative=(error,command,operation_id)=>error?.native_rejection===true&&error.native_command===command&&error.native_operation_id===operation_id;
const safeStartRejections=new Set(['input_busy','invalid_request','invalid_plan','unknown_snapshot','stale_snapshot','target_not_ready','operation_id_reused','request_overflow']);
const rejectedBeforeAdmission=(error,operation_id)=>rejectedByNative(error,'start',operation_id)&&safeStartRejections.has(error.code);
const cleanResumeRejections=new Set(['stale_pause_revision','resume_rejected','resume_limit','unsafe_route','target_changed','foreground_changed','focus_changed','stale_snapshot','user_input_held','keyboard_state_changed','pointer_anomaly']);

/** Admission and cancellation live here; native execution independently revalidates every injection. */
export class HumanService {
  constructor({worker,planners,timers,diagnosticSend}={}) {
    if(!worker?.request)throw new TypeError('worker.request is required');
    this.worker=worker;this.planners=planners;this.timers=timers;this.enabled=false;this.generation=0;this.active=null;this.admission=null;this.poisoned=false;this.history=new Map();this.target=null;
    this.idlePaused=false;this.events=new EventStore();this.nativeSeq=0;this.pollTimer=null;this.polling=null;this.diagnosticSend=diagnosticSend;
    this.pauseGeneration=0;this.safetyGeneration=0;this.idlePauseContext=null;
  }
  async call(name,args={},signal) {
    validateTool(name,args);
    if(name==='human_capabilities') return {protocol:2,version:'0.2.0',platform:'windows',human_mode:this.enabled,cancel_on_user_message:false,page_change_detection:false,deliveryVerified:false,agent_push_supported:false,asynchronous_reading:true,reading_events:['move'],input_history_limit:32,event_history_limit:128,event_bytes_limit:262144,auto_focus:false,safe_activate:true,clipboard_shortcuts:true,clipboard_content_access:false,capture:false,physical_input_provenance:false};
    if(name==='human_events') {if(this.history.size)await this.#poll();return this.events.query(args);}
    if(name==='human_event_ack')return this.events.ack(args);
    if(name==='human_status'){
      const record=args.operation_id?this.history.get(args.operation_id):this.active;
      if(args.operation_id&&!record)throw toolError('unknown_operation','Unknown operation');
      const status=record?await this.#operation('status',{operation_id:record.operation_id}):{state:this.idlePaused?'paused':'idle',pause_mode:this.idlePaused?'manual':null,idle:true};
      if(record)this.#record(record,status);
      return {...status,admission_paused:this.idlePaused,...(this.idlePauseContext?{interrupted_operation:structuredClone(this.idlePauseContext)}:{}),agent_push_supported:false,pending_events:this.events.query({pending_only:true})};
    }
    if(name==='human_pause')return this.#pause(args);
    if(name==='human_resume')return this.#resume(args,signal);
    if(name.startsWith('timer_')) {
      if(!this.timers){const {TimerStore}=await import('./timer.mjs');this.timers=new TimerStore();}
      return this.timers[name.slice(6)](args);
    }
    if(name==='human_observe') return this.worker.request('observe',args);
    if(name==='human_mode') {
      if(args.enabled===undefined)return {enabled:this.enabled};
      if(this.enabled===args.enabled) {
        if(!args.enabled)await this.#cancel(this.active,'human_mode_changed');
        return {enabled:this.enabled};
      }
      this.enabled=args.enabled;this.generation++;
      await this.#cancel(this.active,'human_mode_changed');
      return {enabled:this.enabled};
    }
    if(name==='human_stop') {
      this.generation++;
      const result=await this.#cancel(this.active,args.reason??'stopped');this.idlePaused=false;this.idlePauseContext=null;return result;
    }
    if(name==='human_target_update') {
      const generation=++this.generation;
      await this.#cancel(this.active,'target_changed');
      this.#invalidate(null,'target_changed');
      const observed=await this.worker.request('observe',{hwnd:args.hwnd});
      if(generation!==this.generation)throw toolError('request_superseded','Target change was superseded');
      this.target=observed;
      return observed;
    }
    if(name==='reading_status') {
      const record=this.#reading(args.operation_id);
      if(!record)return {state:'idle'};
      const status=await this.#operation('status',{operation_id:record.operation_id});
      this.#record(record,status);return status;
    }
    if(name==='reading_cancel') {
      const record=this.#reading(args.operation_id);
      if(!record)return {state:'idle'};
      if(record===this.active)this.generation++;
      return this.#cancel(record,args.reason??'reading_cancelled');
    }
    if(name==='human_input_plan') {
      if(args.kind==='typing')return this.#plan('typing',args,null);
      const observation=await this.#observe(args.hwnd);
      return this.#plan(args.kind,args,observation);
    }
    const kind=mouseKinds[name];
    if(!kind)throw toolError('unknown_tool',`Unknown tool: ${name}`);
    return this.#input(kind,args,signal);
  }
  #reading(id) {
    const record=id?this.history.get(id):this.active?.kind==='reading'?this.active:null;
    if(id&&(!record||record.kind!=='reading'))throw toolError('unknown_operation','Unknown reading operation');
    return record;
  }
  #assertCurrent(generation,signal) {
    if(this.poisoned)throw toolError('input_poisoned','Cancellation was not proven; create a new process after worker cleanup');
    if(generation!==this.generation)throw toolError('request_superseded','Input request was superseded by a mode, target, or stop change');
    if(!this.enabled)throw toolError('human_mode_off','Enable human mode explicitly before input');
    if(signal?.aborted)throw toolError('aborted','Input was aborted before native acceptance');
    if(this.idlePaused)throw toolError('input_paused','Explicit resume or stop is required before input');
  }
  async #operation(command,fields){
    const generation=this.generation;
    let result;
    try{result=await this.worker.request(command,fields);}
    catch(error){
      const nativeResumeRejection=command==='resume'&&rejectedByNative(error,command,fields.operation_id);
      if(nativeResumeRejection&&cleanResumeRejections.has(error.code)){
        // A guard code alone is insufficient: prove the same paused owner is clean.
        // A concurrent stop/mode/target change may instead have finished its barrier.
        const status=await this.#operation('status',{operation_id:fields.operation_id});
        // Sampling may have auto-resumed and paused again while Node observed.
        // Only native's stale-revision refusal can prove that forward transition;
        // the caller must inspect the new revision and explicitly retry it.
        const revisionMatches=status.pause_revision===fields.pause_revision||(error.code==='stale_pause_revision'&&status.pause_revision>fields.pause_revision);
        const paused=status.state==='paused'&&revisionMatches&&status.cleanup_confirmed===true;
        const superseded=generation!==this.generation&&terminal(status)&&status.cleanup_confirmed===true;
        if(!paused&&!superseded){this.poisoned=true;throw toolError('cleanup_unconfirmed','Resume refusal did not retain a matching paused cleanup barrier');}
        if(generation!==this.generation)throw toolError('request_superseded','Resume was superseded during refusal confirmation');
        throw error;
      }
      // Native explicitly reports still-pending validation; callers must inspect,
      // never automatically resend. Transport/unknown failures remain poisoned.
      const checkedResumeRejection=nativeResumeRejection&&error.code==='resume_pending';
      const checkedStartRejection=command==='start'&&rejectedBeforeAdmission(error,fields.operation_id);
      if(!checkedResumeRejection&&!checkedStartRejection)this.poisoned=true;
      throw error;
    }
    try{
      validateOperationResult(command,result,fields.operation_id);
      if((terminal(result)||result.state==='paused')&&result.cleanup_confirmed!==true)throw toolError('cleanup_unconfirmed','Native operation cleanup was not proven');
      return result;
    }catch(error){this.poisoned=true;throw error;}
  }
  async #observe(hwnd,activate=false) {
    const observation=await this.worker.request('observe',{hwnd});
    if(observation.ready!==true&&!(activate&&observation.visible&&observation.enabled&&!observation.minimized))throw toolError('target_not_ready','Target must be visible and ready for the requested operation');
    return observation;
  }
  async #plan(kind,args,observation) {
    if(!this.planners)this.planners=await import('./planners.mjs');
    let plan,events;
    const from=observation?.cursor,bounds=observation?.client;
    if(kind==='scroll'||kind==='key'||['copy','cut','paste'].includes(kind)){
      events=kind==='scroll'?Array.from({length:Math.abs(args.delta)/120},(_,i)=>({type:'wheel',axis:args.axis??'vertical',delta:Math.sign(args.delta)*120,at_ms:i*80})):kind==='key'?[{type:'key',key:args.key,modifiers:args.modifiers??[],at_ms:0}]:[{type:'clipboard',action:kind,at_ms:0}];
      plan={durationMs:events.at(-1).at_ms+80,algorithm:'explicit semantic operation'};
    } else if(kind==='activate'){
      const r=args.safe_area,to={x:Math.round(args.x),y:Math.round(args.y)};
      if(!within({x:r.x,y:r.y},bounds)||r.x+r.width>bounds.x+bounds.width||r.y+r.height>bounds.y+bounds.height||!within(to,r))throw toolError('invalid_arguments','Safe click and entire declared safe area must be inside client');
      const distance=Math.hypot(to.x-from.x,to.y-from.y),steps=Math.max(1,Math.ceil(distance/6)),duration=Math.max(args.duration_ms??100,steps*8);
      events=Array.from({length:steps+1},(_,i)=>({type:'move',x:from.x+(to.x-from.x)*i/steps,y:from.y+(to.y-from.y)*i/steps,at_ms:duration*i/steps}));
      if(!events.every(e=>within(e,observation.virtual_desktop)))throw toolError('invalid_plan','Activation approach outside virtual desktop');
      events.push({type:'button_down',at_ms:duration+40},{type:'button_up',at_ms:duration+120});plan={durationMs:duration+120,algorithm:'guarded safe activation approach'};
    } else if(kind==='typing') {
      plan=this.planners.planTyping({text:args.text,wpm:args.wpm,typoRate:args.typo_rate,seed:args.seed});
      const replay=[];
      for(const e of plan.events) {
        if(e.type==='char'&&typeof e.char==='string'&&[...e.char].length===1&&!/[\p{Cc}\p{Cs}]/u.test(e.char))replay.push(e.char);
        else if(e.type==='key'&&e.key==='backspace'&&replay.length)replay.pop();
        else throw toolError('invalid_plan','Typing planner produced an unsupported event');
      }
      if(replay.join('')!==args.text)throw toolError('invalid_plan','Typing planner replay does not match requested text');
      events=plan.events.map(e=>e.type==='char'?{type:'char',text:e.char,at_ms:e.atMs}:{type:'backspace',at_ms:e.atMs});
    } else {
      // Every pointer path stays inside the client; only human_activate may enter from outside.
      if(!within(from,bounds))throw toolError('cursor_outside_client','Current cursor is outside the target client; bring it in with human_activate on a confirmed safe area first');
      if(kind==='reading')plan=this.planners.planReading({from,segments:args.segments,bounds});
      else {
        const to={x:args.x,y:args.y};
        if(!within(to,bounds))throw toolError('point_outside_client','Mouse destination must be inside the target client');
        plan=this.planners.planMove({from,to,durationMs:args.duration_ms,jitterPx:args.jitter_px,overshootPx:args.overshoot_px,bounds,gesture:kind});
      }
      if(!plan.points.every(p=>within(p,bounds)))throw toolError('invalid_plan','Planner produced a point outside target client');
      events=plan.points.map(p=>({type:'move',x:p.x,y:p.y,at_ms:p.atMs}));
      if(kind==='click') {events.push({type:'button_down',at_ms:plan.durationMs},{type:'button_up',at_ms:plan.durationMs+80});plan={...plan,durationMs:plan.durationMs+80};}
      if(kind==='drag') {events.unshift({type:'button_down',at_ms:0});events.push({type:'button_up',at_ms:plan.durationMs+80});plan={...plan,durationMs:plan.durationMs+80};}
    }
    const limit=kind==='typing'?45000:kind==='reading'?60000:15000;
    if(!Number.isFinite(plan.durationMs)||plan.durationMs<=0||plan.durationMs>limit||!events.length||events.length>12000||events.some((e,i)=>!Number.isFinite(e.at_ms)||e.at_ms<0||e.at_ms>plan.durationMs||(i>0&&e.at_ms<events[i-1].at_ms)))throw toolError('invalid_plan','Planner produced an invalid or unbounded event plan');
    return {kind,duration_ms:plan.durationMs,events,algorithm:plan.algorithm,...(kind==='typing'?{target_wpm:plan.targetWpm,character_count:plan.characterCount,seed:plan.seed,effective_typo_rate:plan.effectiveTypoRate}:{}),snapshot_id:observation?.snapshot_id,target_id:observation?.target_id,hwnd:args.hwnd,deliveryVerified:false};
  }
  async #input(kind,args,signal) {
    if(this.poisoned)throw toolError('input_poisoned','Cancellation was not proven; worker cleanup is required');
    if(this.idlePaused)throw toolError('input_paused','Explicit resume or stop is required before input');
    if(this.admission)throw toolError('input_busy','Another input request is being admitted or executed');
    const admission={};this.admission=admission;
    const generation=this.generation;
    try {
      if(this.active) {
        const previous=this.active;
        const pauseGeneration=this.pauseGeneration,safetyGeneration=this.safetyGeneration;
        const status=await this.#operation('status',{operation_id:previous.operation_id});
        this.#assertCurrent(generation,signal);
        this.#record(previous,status);
        if(!terminal(status)) {
          if(['paused','pausing','resuming'].includes(status.state))throw toolError('input_paused','Paused operation must be explicitly resumed or stopped');
          if(previous.kind!=='reading'||(kind==='reading'&&!args.replace))throw toolError('input_busy','An input operation is already running');
          const cancelled=await this.#cancel(previous,'superseded_by_input');
          this.#assertCurrent(generation,signal);
          // Drain after the barrier as an anomaly can precede its native pause revision.
          await this.#drainBarrierEvents();
          this.#assertCurrent(generation,signal);
          if(cancelled.pause_revision>status.pause_revision||this.pauseGeneration!==pauseGeneration||this.safetyGeneration!==safetyGeneration){
            this.idlePaused=true;
            this.idlePauseContext={reason:'pause_discovered_during_replacement',pause_revision:cancelled.pause_revision,old_operation_resumable:false,requires_reobservation_and_replan:true,cancelled_receipt:structuredClone(cancelled),...(this.safetyGeneration!==safetyGeneration&&this.lastSafetyEvent?{safety_event:structuredClone(this.lastSafetyEvent)}:{})};
            this.#invalidate(previous.target_id,'pause_discovered_during_replacement');
            throw toolError('input_paused','Reading was cancelled at the replacement barrier while a new pause was discovered. Explicit idle resume or stop is required; reobserve and replan remaining reading.');
          }
        }
      }
      this.#assertCurrent(generation,signal);
      const observation=await this.#observe(args.hwnd,kind==='activate');
      this.#assertCurrent(generation,signal);
      if(this.target&&this.target.target_id!==observation.target_id)this.#invalidate(null,'target_changed');
      this.target=observation;
      const plan=await this.#plan(kind,args,observation);
      this.#assertCurrent(generation,signal);
      const record={operation_id:randomUUID(),kind,state:'starting',hwnd:args.hwnd,target_id:observation.target_id,startOutcome:'pending',nativeAccepted:false};
      this.active=record;this.#record(record,{state:'starting'});
      try {
        record.startPending=true;
        record.startPromise=this.#operation('start',{operation_id:record.operation_id,snapshot_id:plan.snapshot_id,kind,duration_ms:plan.duration_ms,events:plan.events,threshold_px:args.threshold_px??8,...(kind==='typing'?{force_ime_off:args.force_ime_off??false}:{}),...(args.pause_policy?{pause_policy:args.pause_policy}:{}),...(kind==='activate'?{safe_area:args.safe_area,safe_area_confirmed:true}:{})}).then(
          accepted=>{record.startOutcome='accepted';record.nativeAccepted=true;return accepted;},
          error=>{record.startOutcome=rejectedBeforeAdmission(error,record.operation_id)?'rejected':'ambiguous';throw error;}
        );
        record.startPromise.then(()=>{record.startPending=false;},()=>{record.startPending=false;});
        let resolveStartAbort;
        const startAbortOutcome=new Promise(resolve=>{resolveStartAbort=resolve;});
        const abortStart=()=>{this.#cancel(record,'aborted').then(status=>resolveStartAbort({cancelled:status}),error=>resolveStartAbort({error}));};
        signal?.addEventListener('abort',abortStart,{once:true});
        if(signal?.aborted)abortStart();
        let outcome;
        try {outcome=await Promise.race([record.startPromise.then(accepted=>({accepted})),startAbortOutcome]);}
        finally {signal?.removeEventListener('abort',abortStart);}
        if(outcome.error)throw outcome.error;
        if(outcome.cancelled)return outcome.cancelled;
        const {accepted}=outcome;
        if(generation!==this.generation||!this.enabled||signal?.aborted) {
          const cancelled=await this.#cancel(record,signal?.aborted?'aborted':'request_superseded');
          if(signal?.aborted)return cancelled;
          throw toolError('request_superseded','Input was superseded during native acceptance');
        }
        if(record.state==='starting')this.#record(record,accepted);
        this.#schedulePoll();
        if(kind==='reading')return record.lastStatus;
        return await this.#wait(record,plan.duration_ms,signal);
      } catch(error) {
        if(this.active===record) {
          // A transport error may have happened after acceptance. Never permit a fresh start
          // without trying a barrier; failure poisons admission for this process.
          try {await this.#cancel(record,'input_error');} catch {/* poison is retained */}
        }
        throw error;
      }
    } finally {if(this.admission===admission)this.admission=null;}
  }
  async #wait(record,duration,signal) {
    const deadline=performance.now()+duration+5000;
    let abortPromise,resolveAbort;
    const abortOutcome=new Promise(resolve=>{resolveAbort=resolve;});
    const abort=()=>{
      if(!abortPromise) {
        abortPromise=this.#cancel(record,'aborted');
        abortPromise.then(status=>resolveAbort({aborted:true,status}),error=>resolveAbort({aborted:true,error}));
      }
    };
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    try {
      for(;;) {
        if(abortPromise)return await abortPromise;
        const outcome=await Promise.race([this.#operation('status',{operation_id:record.operation_id}).then(status=>({status})),abortOutcome]);
        if(outcome.error)throw outcome.error;
        const {status}=outcome;
        if(outcome.aborted)return status;
        if(abortPromise)return await abortPromise;
        this.#record(record,status);
        if(terminal(status))return status;
        if(status.state==='paused'&&status.pause_mode!=='sampling')return status;
        if(performance.now()>deadline){await this.#cancel(record,'operation_timeout');throw toolError('operation_timeout','Operation exceeded its bounded completion deadline');}
        await delay(20);
      }
    } finally {signal?.removeEventListener('abort',abort);}
  }
  async #cancel(record,reason) {
    if(!record)return {state:'idle'};
    if(record.cancelPromise)return record.cancelPromise;
    record.cancelPromise=(async()=>{
      let deadline;
      try {
        const cancellation=(async()=>{
          const startPending=record.startPending,resumePending=record.resumePending;
          let result=await this.#operation('cancel',{operation_id:record.operation_id,reason});
          if(startPending) {
            // A delayed acceptance response cannot outlive a mode/stop barrier.
            await record.startPromise.catch(()=>{});
            if(result.state==='idle'&&record.startOutcome!=='rejected')result=await this.#operation('cancel',{operation_id:record.operation_id,reason});
          }
          if(resumePending){await record.resumePromise.catch(()=>{});result=await this.#operation('cancel',{operation_id:record.operation_id,reason});}
          return result;
        })();
        const result=await Promise.race([cancellation,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(toolError('cancellation_timeout','Cancellation barrier exceeded 2 seconds')),2000);})]);
        if(result.state==='idle'&&record.startOutcome==='rejected'&&!record.nativeAccepted){
          // No operation was admitted. Idle confirms absence, not active cleanup.
          record.state='rejected';record.lastStatus={state:'idle'};
          this.history.delete(record.operation_id);
          if(this.active===record)this.active=null;
          if(!this.active){clearTimeout(this.pollTimer);this.pollTimer=null;}
          return result;
        }
        if(!terminal(result)||result.cleanup_confirmed!==true)throw toolError('cleanup_unconfirmed','Worker did not prove terminal operation cleanup');
        this.#record(record,result);return result;
      } catch(error) {this.poisoned=true;throw error;}
      finally {clearTimeout(deadline);record.cancelPromise=null;}
    })();
    return record.cancelPromise;
  }
  #record(record,status) {
    if(['paused','resuming'].includes(status.state)&&record.state!==status.state)this.#invalidate(record.target_id,`input_${status.state}`);
    record.lastStatus=structuredClone(status);Object.assign(record,status);this.history.set(record.operation_id,record);
    if((terminal(status)||status.state==='idle')&&this.active===record)this.active=null;
    if(!this.active){clearTimeout(this.pollTimer);this.pollTimer=null;}
    for(const [id,entry] of this.history) {
      if(this.history.size<=32)break;
      if(entry!==this.active&&terminal(entry))this.history.delete(id);
    }
  }
  #invalidate(target_id,reason){this.timers?.invalidateTarget?.({target_id,reason});}
  #schedulePoll(){if(this.pollTimer||!this.active||this.poisoned)return;this.pollTimer=setTimeout(()=>{this.pollTimer=null;void this.#poll().catch(()=>{}).finally(()=>this.#schedulePoll());},100);this.pollTimer.unref?.();}
  async #drainBarrierEvents(){
    if(this.polling)await this.polling;
    // Native retains 256 events. After terminal cancellation at most two full
    // pages plus an empty tail are possible; never admit on an undrained tail.
    for(let page=0;page<3;page++){
      const result=await this.#poll();
      if(result.records.length<128)return;
    }
    this.poisoned=true;
    throw toolError('protocol_error','Native safety event history did not settle after cancellation');
  }
  async #poll(){
    if(this.polling)return this.polling;
    this.polling=(async()=>{
      try{
        const result=validateNativeEvents(await this.worker.request('events',{after_seq:this.nativeSeq,limit:128}),this.nativeSeq);
        if(result.overflow){this.events.native_overflow_count++;this.safetyGeneration++;}
        for(const e of result.records){
          const receipt=this.events.add(e),record=this.history.get(e.operation_id);
          if(['anomaly','paused','pointer_takeover','external_observation_required'].includes(e.event)){this.safetyGeneration++;this.lastSafetyEvent=structuredClone(e);}
          if(['anomaly','paused','pointer_takeover','external_observation_required','auto_resumed','resumed'].includes(e.event))this.#invalidate(record?.target_id,`native_${e.event}`);
          if(receipt&&this.diagnosticSend)void this.events.diagnostic(receipt,this.diagnosticSend);
        }
        this.nativeSeq=result.next_seq;
        return result;
      }catch(error){
        this.poisoned=true;
        try{await this.#cancel(this.active,'event_poll_failed');}catch{}
        throw error;
      }
    })();
    try{return await this.polling;}finally{this.polling=null;}
  }
  async #pause(args){
    if(this.poisoned)throw toolError('input_poisoned','Worker cleanup is required');
    const record=this.active;
    if(args.operation_id&&args.operation_id!==record?.operation_id)throw toolError('unknown_operation','Operation is not current');
    this.pauseGeneration++;
    if(!record){this.idlePaused=true;this.generation++;this.#invalidate(null,'idle_pause');return {state:'paused',pause_mode:'manual',idle:true};}
    const status=await this.#operation('pause',{operation_id:record.operation_id,reason:'explicit_pause'});
    if((status.state!=='paused'&&!terminal(status))||status.cleanup_confirmed!==true){this.poisoned=true;throw toolError('cleanup_unconfirmed','Native pause cleanup barrier was not confirmed');}
    this.#record(record,status);return status;
  }
  async #resume(args,signal){
    if(this.poisoned)throw toolError('input_poisoned','Worker cleanup is required');
    if(this.idlePaused&&!this.active){if(Object.keys(args).length)throw toolError('invalid_arguments','Idle resume requires empty arguments');const interrupted_operation=this.idlePauseContext;this.idlePaused=false;this.idlePauseContext=null;this.#invalidate(null,'idle_resume');return {state:'idle',resumed_idle:true,...(interrupted_operation?{interrupted_operation:structuredClone(interrupted_operation)}:{})};}
    const record=this.active,generation=this.generation;
    this.#assertCurrent(generation,signal);
    if(!record)throw toolError('input_not_paused','No current operation to resume');
    if(record.resumeAdmission)throw toolError('input_busy','Resume is already being admitted');
    if(args.operation_id!==record.operation_id||args.pause_revision===undefined||args.external_checked!==true||!args.resolution)throw toolError('invalid_arguments','Resume needs current operation/revision, external_checked=true and explicit resolution');
    record.resumeAdmission=true;
    try{
      const status=await this.#operation('status',{operation_id:record.operation_id});this.#assertCurrent(generation,signal);
      this.#record(record,status);
      if(status.state!=='paused'||status.pause_revision!==args.pause_revision||status.cleanup_confirmed!==true)throw toolError('stale_pause_revision','Fresh paused cleanup barrier is required');
      const observed=await this.worker.request('observe',{hwnd:record.hwnd});this.#assertCurrent(generation,signal);
      record.resumePending=true;record.resumePromise=this.#operation('resume',{operation_id:record.operation_id,pause_revision:args.pause_revision,snapshot_id:observed.snapshot_id,external_checked:true,resolution:args.resolution});
      record.resumePromise.then(()=>{record.resumePending=false;},()=>{record.resumePending=false;});
      const accepted=await record.resumePromise;
      if(generation!==this.generation||!this.enabled||signal?.aborted){await this.#cancel(record,'request_superseded');throw toolError('request_superseded','Resume was superseded during native acceptance');}
      this.#invalidate(record.target_id,'input_resume');this.#record(record,accepted);this.#schedulePoll();return accepted;
    }finally{record.resumeAdmission=false;}
  }
}
