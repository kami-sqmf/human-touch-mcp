// Real release-worker IPC. Never requests an executable input operation:
// every start references an unknown snapshot, and observe uses HWND 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

test('release worker strictly frames IPC, accepts fractional plans, and exits on EOF', {timeout: 8000}, async () => {
  const executable = process.env.HUMAN_INPUT_WORKER ?? fileURLToPath(new URL('../target/release/human-input-worker.exe', import.meta.url));
  const worker = spawn(executable, [], {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
  const waiting = new Map();
  let stderr = '';
  worker.stderr.on('data', data => { stderr += data; });
  const exited = new Promise((resolve, reject) => { worker.once('exit', code => resolve(code)); worker.once('error', reject); });
  const lines = createInterface({input: worker.stdout});
  lines.on('line', line => {
    const message = JSON.parse(line);
    const complete = waiting.get(message.id);
    assert.ok(complete, `Unexpected stdout response: ${line}`);
    waiting.delete(message.id);
    complete(message);
  });
  function request(message, raw = JSON.stringify(message)) {
    return new Promise(resolve => { waiting.set(message.id, resolve); worker.stdin.write(raw + '\n'); });
  }
  try {
    const hello = await request({id: 1, command: 'hello'});
    assert.equal(hello.result.protocol, 2);
    assert.equal(hello.result.version, '0.2.0');
    assert.equal(hello.result.platform, 'windows');
    assert.equal(hello.result.capabilities.cancel_on_user_message, false);
    assert.equal(hello.result.capabilities.page_change_detection, false);
    for (const name of ['scroll','key','copy','cut','paste','activate','pause','resume','events']) assert.equal(hello.result.capabilities[name], true);
    const [ping, unknown, extra] = await Promise.all([
      request({id: 2, command: 'ping'}), request({id: 3, command: 'unknown'}), request({id: 4, command: 'ping', extra: true}),
    ]);
    assert.deepEqual(ping.result, {alive: true});
    assert.equal(unknown.error.code, 'invalid_request');
    assert.equal(extra.error.code, 'invalid_request');
    assert.equal((await request({id: 5, command: 'observe', hwnd: '0'})).error.code, 'invalid_hwnd');
    assert.equal((await request({id:20,command:'observe',hwnd:'18446744073709551616'})).error.code,'invalid_hwnd');
    for(const [index,field] of ['small_excursion_px','large_range_px','large_path_px'].entries()){
      const plan={command:'start',operation_id:'policy-shape',snapshot_id:'never-observed',kind:'move',duration_ms:100,events:[{type:'move',x:10,y:10,at_ms:0}],pause_policy:{[field]:[80,180,240][index]}};
      assert.equal((await request({id:21+index*2,...plan})).error.code,'unknown_snapshot');
      plan.pause_policy[field]+=.5;
      assert.equal((await request({id:22+index*2,...plan})).error.code,'invalid_request');
    }
    for (const [id, kind, duration_ms, events] of [
      [6, 'move', 100.125, [{type: 'move', x: 10.25, y: 20.5, at_ms: 50.0625}]],
      [7, 'typing', 1463.4146341463415, [{type: 'char', text: 'H', at_ms: 0.25}, {type: 'char', text: 'i', at_ms: 292.6829268292683}]],
      [10, 'scroll', 100, [{type:'wheel',axis:'horizontal',delta:120,at_ms:0}]],
      [11, 'key', 100, [{type:'key',key:'enter',modifiers:['ctrl'],at_ms:0}]],
      [12, 'cut', 100, [{type:'clipboard',action:'cut',at_ms:0}]],
    ]) {
      const reply = await request({id, command: 'start', operation_id: `op-${id}`, snapshot_id: 'never-observed', kind, duration_ms, events});
      assert.equal(reply.error.code, 'unknown_snapshot', 'Fractional valid plan must pass parsing and validation before failing snapshot lookup');
    }
    assert.equal((await request({id:13,command:'pause',operation_id:'absent'})).error.code, 'unknown_operation');
    assert.equal((await request({id:14,command:'resume',operation_id:'absent',pause_revision:1,snapshot_id:'absent',external_checked:true,resolution:{type:'continue'}})).error.code, 'unknown_snapshot');
    assert.deepEqual((await request({id:15,command:'events',after_seq:0,limit:32})).result, {records:[],next_seq:0,oldest_seq:1,overflow:false});
    assert.equal((await request({id:16,command:'start',operation_id:'forbidden',snapshot_id:'absent',kind:'key',duration_ms:100,events:[{type:'key',key:'v',modifiers:['ctrl'],at_ms:0}]})).error.code, 'invalid_request');
    const activation = {command:'start',operation_id:'activate',snapshot_id:'never-observed',kind:'activate',duration_ms:100,safe_area:{x:15,y:25,width:20,height:20},safe_area_confirmed:true,events:[{type:'move',x:20,y:30,at_ms:0},{type:'button_down',at_ms:20},{type:'button_up',at_ms:70}]};
    assert.equal((await request({id:17,...activation})).error.code, 'unknown_snapshot');
    for (const [id, at_ms] of [[18,70],[19,80]]) {
      const reply = await request({id,...activation,events:[...activation.events,{type:'move',x:40,y:30,at_ms}]});
      assert.equal(reply.error.code, 'invalid_plan', 'Post-up activation input must fail validation before snapshot lookup');
    }
    const malformed = await request({id: null}, '{broken json');
    assert.equal(malformed.id, null);
    assert.equal(malformed.error.code, 'invalid_request');
    const oversized = await request({id: null}, 'x'.repeat(2 * 1024 * 1024 + 1));
    assert.equal(oversized.error.code, 'line_too_long');
    assert.deepEqual((await request({id: 8, command: 'ping'})).result, {alive: true});
    assert.deepEqual((await request({id: 9, command: 'cancel'})).result, {state: 'idle'});
    worker.stdin.end();
    assert.equal(await exited, 0);
    assert.equal(stderr, '');
    assert.equal(waiting.size, 0);
  } finally {
    // Readonly test cleanup uses EOF; never turn a test failure into forced worker death.
    if (worker.exitCode === null) worker.stdin.end();
    lines.close();
  }
});
