import test from 'node:test';
import assert from 'node:assert/strict';
import {TimerStore} from '../lib/timer.mjs';
function fixture(){let now=0,wall=1_000_000;const timers=new TimerStore({now:()=>now,wallNow:()=>wall});const t=timers.attach({target_id:'window',section_id:'s'});return {timers,id:t.timer_id,advance:n=>now+=n,wall:n=>wall=n};}
test('unknown timers have no estimate; calibration preserves capture uncertainty',()=>{
  const f=fixture();assert.equal(f.timers.status({timer_id:f.id}).estimate,null);
  const ticket=f.timers.prepare({timer_id:f.id});f.advance(2000);
  const s=f.timers.calibrate({timer_id:f.id,ticket_id:ticket.ticket_id,observed_seconds:100});
  assert.equal(s.observed.seconds,100);assert.equal(s.estimate.min_seconds,97);assert.equal(s.estimate.max_seconds,101);
  f.wall(-99999999);f.advance(1000);
  assert.equal(f.timers.status({timer_id:f.id}).estimate.min_seconds,96);
  assert.throws(()=>f.timers.calibrate({timer_id:f.id,ticket_id:ticket.ticket_id,observed_seconds:99}));
});
test('stale threshold is 60s normally and 10s in final30; no estimate when stale',()=>{
  for(const [seconds,limit] of [[200,60000],[20,10000]]){
    const f=fixture(),ticket=f.timers.prepare({timer_id:f.id});f.timers.calibrate({timer_id:f.id,ticket_id:ticket.ticket_id,observed_seconds:seconds});
    f.advance(limit);const s=f.timers.status({timer_id:f.id});assert.equal(s.state,'stale');assert.equal(s.estimate,null);
  }
});
test('estimated expiry differs from observed expiry and pause does not count down',()=>{
  const f=fixture();let ticket=f.timers.prepare({timer_id:f.id});
  f.timers.calibrate({timer_id:f.id,ticket_id:ticket.ticket_id,observed_seconds:1});f.advance(3000);
  assert.equal(f.timers.status({timer_id:f.id}).state,'expired_estimated');
  ticket=f.timers.prepare({timer_id:f.id});
  assert.equal(f.timers.calibrate({timer_id:f.id,ticket_id:ticket.ticket_id,observed_seconds:0,state:'expired_observed'}).state,'expired_observed');
  ticket=f.timers.prepare({timer_id:f.id});f.timers.calibrate({timer_id:f.id,ticket_id:ticket.ticket_id,observed_seconds:20,state:'paused_observed'});f.advance(5000);
  assert.equal(f.timers.status({timer_id:f.id}).estimate.min_seconds,19);
});
test('drift is an interval, invalidation clears estimation and invalidates tickets',()=>{
  const f=fixture();let ticket=f.timers.prepare({timer_id:f.id});f.timers.calibrate({timer_id:f.id,ticket_id:ticket.ticket_id,observed_seconds:100});
  f.advance(10000);ticket=f.timers.prepare({timer_id:f.id});
  const s=f.timers.calibrate({timer_id:f.id,ticket_id:ticket.ticket_id,observed_seconds:95});
  assert.deepEqual(s.drift_seconds,{min:3,max:7});
  ticket=f.timers.prepare({timer_id:f.id});const invalid=f.timers.invalidate({timer_id:f.id,reason:'target changed'});
  assert.equal(invalid.estimate,null);assert.deepEqual(invalid.drift_seconds,{min:3,max:7});
  assert.throws(()=>f.timers.calibrate({timer_id:f.id,ticket_id:ticket.ticket_id,observed_seconds:90}));
});
test('expired tickets, cross-timer tickets and invalid observations are rejected',()=>{
  const f=fixture();const ticket=f.timers.prepare({timer_id:f.id});
  const other=f.timers.attach({target_id:'window',section_id:'other'});
  assert.throws(()=>f.timers.calibrate({timer_id:other.timer_id,ticket_id:ticket.ticket_id,observed_seconds:5}));
  assert.throws(()=>f.timers.calibrate({timer_id:f.id,ticket_id:ticket.ticket_id,observed_seconds:-1}));
  assert.throws(()=>f.timers.calibrate({timer_id:f.id,ticket_id:ticket.ticket_id,observed_seconds:1,state:'expired_observed'}));
  f.advance(60001);assert.throws(()=>f.timers.calibrate({timer_id:f.id,ticket_id:ticket.ticket_id,observed_seconds:5}));
  f.timers.detach({timer_id:f.id});assert.throws(()=>f.timers.status({timer_id:f.id}));
});
test('timer/ticket stores are bounded and cannot silently replace existing identity',()=>{
  const f=fixture();assert.throws(()=>f.timers.attach({target_id:'other',section_id:'s',timer_id:f.id}));
  const first=f.timers.prepare({timer_id:f.id});for(let i=0;i<32;i++)f.timers.prepare({timer_id:f.id});
  assert.throws(()=>f.timers.calibrate({timer_id:f.id,ticket_id:first.ticket_id,observed_seconds:5}));
  for(let i=1;i<32;i++)f.timers.attach({target_id:'t',section_id:String(i)});
  assert.throws(()=>f.timers.attach({target_id:'t',section_id:'overflow'}));
});
test('regressed monotonic source fails closed and returned observations cannot mutate state',()=>{
  const f=fixture(),ticket=f.timers.prepare({timer_id:f.id});
  const s=f.timers.calibrate({timer_id:f.id,ticket_id:ticket.ticket_id,observed_seconds:100});
  s.observed.seconds=900;s.estimate.min_seconds=800;
  assert.equal(f.timers.status({timer_id:f.id}).observed.seconds,100);
  f.advance(-1);assert.throws(()=>f.timers.status({timer_id:f.id}),/regressed/);
});
test('timer reports estimate provenance and only warns on certain large drift',()=>{
  const f=fixture();let ticket=f.timers.prepare({timer_id:f.id});
  let s=f.timers.calibrate({timer_id:f.id,ticket_id:ticket.ticket_id,observed_seconds:100});
  assert.equal(s.source,'estimated');assert.equal(s.observed.source,'observed');assert.equal(s.assumes_running,true);
  f.advance(10000);ticket=f.timers.prepare({timer_id:f.id});
  s=f.timers.calibrate({timer_id:f.id,ticket_id:ticket.ticket_id,observed_seconds:95});assert.deepEqual(s.warnings,['timer_drift']);
  // A wide capture bracket straddles zero drift; uncertainty is not evidence of drift.
  ticket=f.timers.prepare({timer_id:f.id});f.advance(10000);
  s=f.timers.calibrate({timer_id:f.id,ticket_id:ticket.ticket_id,observed_seconds:90});assert.deepEqual(s.warnings,[]);
  ticket=f.timers.prepare({timer_id:f.id});s=f.timers.calibrate({timer_id:f.id,ticket_id:ticket.ticket_id,observed_seconds:90,state:'paused_observed'});
  assert.equal(s.assumes_running,false);assert.equal(s.source,'observed');
});
test('unknown display rounding includes floor and ceil sources without negative lower bounds',()=>{
  for(const seconds of [0,1,10]){
    const f=fixture(),ticket=f.timers.prepare({timer_id:f.id});
    const s=f.timers.calibrate({timer_id:f.id,ticket_id:ticket.ticket_id,observed_seconds:seconds});
    assert.equal(s.display_rounding,'unknown');
    assert.equal(s.estimate.min_seconds,Math.max(0,seconds-1));assert.equal(s.estimate.max_seconds,seconds+1);
    // A ceiling display can show 10 with 9.1 remaining; flooring can show 10 with 10.9.
    if(seconds===10)assert.ok(s.estimate.min_seconds<=9.1&&s.estimate.max_seconds>=10.9);
  }
});
