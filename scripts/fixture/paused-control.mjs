import assert from 'node:assert/strict';

export async function exercisePausedControl({control,startReading,call,fresh,stableAfterBarrier,settle}) {
  assert.ok(['stop','mode_off'].includes(control),'Unknown paused control case');
  const run=await startReading(8000);
  const operationId=run.result.operation_id;
  await settle();
  const paused=await call('human_pause',{operation_id:operationId});
  assert.equal(paused.operation_id,operationId,'Paused operation differs');
  assert.equal(paused.state,'paused','Operation must be proved paused');
  assert.equal(paused.cleanup_confirmed,true,'Paused cleanup barrier is required');
  const pauseStability=await stableAfterBarrier(await fresh());

  const controlReceipt=control==='stop'
    ? await call('human_stop')
    : await call('human_mode',{enabled:false});
  const terminalSnapshot=await fresh();
  if(control==='stop') {
    assert.equal(controlReceipt.operation_id,operationId);
    assert.equal(controlReceipt.state,'cancelled');
    assert.equal(controlReceipt.cleanup_confirmed,true,'Stop cleanup barrier is required');
  } else assert.equal(controlReceipt.enabled,false,'Mode-off was not confirmed');

  const terminal=await call('human_status',{operation_id:operationId});
  assert.equal(terminal.operation_id,operationId);
  assert.equal(terminal.state,'cancelled','Paused operation must reach cancelled');
  assert.equal(terminal.cleanup_confirmed,true,'Terminal cleanup barrier is required');
  const terminalStability=await stableAfterBarrier(terminalSnapshot);
  return {operation_id:operationId,paused,control_receipt:controlReceipt,terminal,
    pause_stability:pauseStability,terminal_stability:terminalStability};
}
