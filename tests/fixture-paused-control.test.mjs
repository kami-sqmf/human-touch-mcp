import test from 'node:test';
import assert from 'node:assert/strict';
import {exercisePausedControl} from '../scripts/fixture/paused-control.mjs';

function receiverModel({pauseState='paused',pauseCleanup=true}={}) {
  let enabled=true,current,sequence=0;
  const history=new Map(),controls=[],stability=[],starts=[];
  const receipt=()=>({operation_id:current.operation_id,state:current.state,cleanup_confirmed:current.state!=='running'});
  return {
    controls,stability,starts,
    async startReading() {
      assert.equal(enabled,true);
      current={operation_id:`op-${starts.length+1}`,state:'running'};
      starts.push(current.operation_id);history.set(current.operation_id,current);
      return {result:receipt()};
    },
    async call(name,args={}) {
      if(name==='human_pause') {
        assert.equal(args.operation_id,current.operation_id);
        current.state=pauseState;
        return {...receipt(),cleanup_confirmed:pauseCleanup};
      }
      if(name==='human_stop'||name==='human_mode') {
        controls.push({name,operation_id:current.operation_id,before:current.state});
        current.state='cancelled';
        if(name==='human_mode'){enabled=false;return {enabled};}
        return receipt();
      }
      assert.equal(name,'human_status');
      const old=history.get(args.operation_id);
      return {operation_id:old.operation_id,state:old.state,cleanup_confirmed:old.state!=='running'};
    },
    async fresh() {return {sequence:++sequence,operation_id:current.operation_id,state:current.state};},
    async stableAfterBarrier(snapshot) {
      stability.push({operation_id:snapshot.operation_id,state:snapshot.state});
      return {ack_sequence:snapshot.sequence,checked_sequence:++sequence};
    },
    async settle() {},
  };
}

test('stop and direct mode-off each act on a separate proved-paused operation and independently verify stability',async()=>{
  const model=receiverModel();
  const stopped=await exercisePausedControl({...model,control:'stop'});
  const disabled=await exercisePausedControl({...model,control:'mode_off'});
  assert.deepEqual(model.starts,['op-1','op-2']);
  assert.deepEqual(model.controls,[
    {name:'human_stop',operation_id:'op-1',before:'paused'},
    {name:'human_mode',operation_id:'op-2',before:'paused'},
  ]);
  assert.deepEqual(model.stability,[
    {operation_id:'op-1',state:'paused'},{operation_id:'op-1',state:'cancelled'},
    {operation_id:'op-2',state:'paused'},{operation_id:'op-2',state:'cancelled'},
  ]);
  for(const result of [stopped,disabled]) {
    assert.equal(result.paused.state,'paused');assert.equal(result.paused.cleanup_confirmed,true);
    assert.equal(result.terminal.state,'cancelled');assert.equal(result.terminal.cleanup_confirmed,true);
  }
});

test('unproved pause refuses either control case before stop or mode-off',async()=>{
  for(const control of ['stop','mode_off']) {
    for(const patch of [{pauseState:'running'},{pauseCleanup:false}]) {
      const model=receiverModel(patch);
      await assert.rejects(exercisePausedControl({...model,control}),/paused|cleanup/i);
      assert.equal(model.controls.length,0);
    }
  }
});
