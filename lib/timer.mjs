import {randomUUID} from 'node:crypto';

function identifier(value,name){if(typeof value!=='string'||!value.trim()||value.length>256)throw new TypeError(`Invalid ${name}`);return value;}
/** External countdown observations only. No worker, page, or desktop access. */
export class TimerStore {
  #timers=new Map();#tickets=new Map();#now;#wallNow;#lastNow=-Infinity;
  constructor({now=()=>performance.now(),wallNow=()=>Date.now()}={}){this.#now=now;this.#wallNow=wallNow;}
  #time(){const n=this.#now();if(!Number.isFinite(n)||n<this.#lastNow)throw new Error('Monotonic timer clock regressed');this.#lastNow=n;return n;}
  #get(id){const timer=this.#timers.get(id);if(!timer)throw new Error('Unknown timer_id');return timer;}
  #dropTickets(id){for(const [key,ticket] of this.#tickets)if(ticket.timer_id===id)this.#tickets.delete(key);}
  #prune(now){for(const [id,t] of this.#tickets)if(now-t.prepared>60000)this.#tickets.delete(id);}
  attach({target_id,section_id,timer_id=randomUUID()}){
    identifier(target_id,'target_id');identifier(section_id,'section_id');identifier(timer_id,'timer_id');
    if(this.#timers.has(timer_id))throw new Error('timer_id already attached');
    if(this.#timers.size>=32)throw new Error('Timer capacity reached; detach a timer');
    this.#timers.set(timer_id,{timer_id,target_id,section_id,anchor:null,observed:null,drift:null,invalid:false});
    return this.status({timer_id});
  }
  prepare({timer_id}){
    this.#get(timer_id);const now=this.#time();this.#prune(now);
    if(this.#tickets.size>=32)this.#tickets.delete(this.#tickets.keys().next().value);
    const ticket_id=randomUUID(),prepared_at=new Date(this.#wallNow()).toISOString();
    this.#tickets.set(ticket_id,{timer_id,prepared:now});return {timer_id,ticket_id,prepared_at};
  }
  #range(anchor,now){
    if(anchor.state==='expired_observed')return {min:0,max:0};
    // The external display may floor or ceil. Its rounding is unknown, so
    // retain both possibilities, plus the prepare/receipt capture bracket.
    const lower=Math.max(0,anchor.seconds-1);
    if(anchor.state==='paused_observed')return {min:lower,max:anchor.seconds+1};
    return {min:Math.max(0,lower-(now-anchor.prepared)/1000),max:Math.max(0,anchor.seconds+1-(now-anchor.received)/1000)};
  }
  calibrate({timer_id,ticket_id,observed_seconds,state='running'}){
    const t=this.#get(timer_id),now=this.#time(),ticket=this.#tickets.get(ticket_id);
    if(!ticket||ticket.timer_id!==timer_id||now-ticket.prepared>60000)throw new Error('Unknown, stale, or mismatched observation ticket');
    if(!Number.isInteger(observed_seconds)||observed_seconds<0||observed_seconds>31536000)throw new TypeError('observed_seconds must be an integer in 0..31536000');
    if(!['running','paused_observed','expired_observed'].includes(state)||state==='expired_observed'&&observed_seconds!==0)throw new TypeError('Invalid observed timer state');
    let drift=null;
    if(t.anchor&&!t.invalid){
      const before=this.#range(t.anchor,ticket.prepared),after=this.#range(t.anchor,now);
      const lower=state==='expired_observed'?0:Math.max(0,observed_seconds-1);
      drift={min:lower-before.max,max:observed_seconds+(state==='expired_observed'?0:1)-after.min};
    }
    const observed={seconds:observed_seconds,state,source:'observed',received_at:new Date(this.#wallNow()).toISOString()};
    t.anchor={seconds:observed_seconds,state,prepared:ticket.prepared,received:now};t.observed=observed;t.drift=drift;t.invalid=false;delete t.reason;
    this.#dropTickets(timer_id);return this.status({timer_id});
  }
  status({timer_id}){
    const t=this.#get(timer_id),now=this.#time();let state='unknown',estimate=null,age_ms=null,stale=false;
    if(t.anchor&&!t.invalid){
      const range=this.#range(t.anchor,now);age_ms=now-t.anchor.prepared;
      const staleAfter=t.anchor.state==='running'&&range.min<=30?10000:60000;
      stale=age_ms>=staleAfter;
      if(t.anchor.state==='expired_observed'){state='expired_observed';stale=false;estimate={seconds:0,min_seconds:0,max_seconds:0};}
      else if(stale)state='stale';
      else{
        state=t.anchor.state==='running'&&range.max<=0?'expired_estimated':t.anchor.state;
        estimate={seconds:Math.max(0,Math.floor((range.min+range.max)/2)),min_seconds:Math.floor(range.min),max_seconds:Math.ceil(range.max)};
      }
    }
    const assumes_running=state==='running'||state==='expired_estimated';
    const source=estimate?(assumes_running?'estimated':'observed'):null;
    const warnings=t.drift&&(t.drift.min>2||t.drift.max< -2)?['timer_drift']:[];
    return {timer_id:t.timer_id,target_id:t.target_id,section_id:t.section_id,state,source,assumes_running,display_rounding:'unknown',observed:t.observed?{...t.observed}:null,estimate,age_ms,stale,drift_seconds:t.drift?{...t.drift}:null,warnings,...(t.reason?{reason:t.reason}:{})};
  }
  invalidate({timer_id,reason='invalidated'}){
    const t=this.#get(timer_id);identifier(reason,'reason');t.invalid=true;t.reason=reason;this.#dropTickets(timer_id);return this.status({timer_id});
  }
  detach({timer_id}){this.#get(timer_id);this.#dropTickets(timer_id);this.#timers.delete(timer_id);return {timer_id,detached:true};}
  invalidateTarget({target_id,reason}){for(const t of this.#timers.values())if(!target_id||t.target_id===target_id)this.invalidate({timer_id:t.timer_id,reason});}
}
