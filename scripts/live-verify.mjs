// Automated visible acceptance against two fresh run-owned windows only.
// Usage: node scripts/live-verify.mjs [--worker PATH] [--manual-motion] [--keep-ime]
//        [--discard-clipboard] [--only case1,case2]
// Keep hands off the mouse and keyboard while it runs (~1 minute).
import assert from 'node:assert/strict';
import {randomBytes, createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Fixture, delay, waitFor} from './fixture/runtime.mjs';
import {validateObservation, knownTextEvidence, classifyAcceptanceError, validateCoordinateSource} from './fixture/guards.mjs';
import {exercisePausedControl} from './fixture/paused-control.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (args.includes('--help')) {
  console.log('node scripts/live-verify.mjs [--worker PATH] [--manual-motion] [--keep-ime] [--discard-clipboard] [--only a,b]');
  console.log('  --worker            worker exe (default: native/target/portable/.../release/human-input-worker.exe)');
  console.log('  --manual-motion     also run the two cases that need you to move the mouse when prompted');
  console.log('  --keep-ime          do not pass force_ime_off:true to human_type (default passes it)');
  console.log('  --discard-clipboard if the clipboard holds non-text data, allow emptying it instead of skipping the clipboard case');
  console.log('  --only              comma-separated case names');
  process.exit(0);
}
const worker = resolve(option('--worker') ?? join(root, 'native/target/portable/x86_64-pc-windows-msvc/release/human-input-worker.exe'));
assert.ok(existsSync(worker), `Worker not found: ${worker}. Build with scripts/build.ps1 -NoCopy or pass --worker.`);
const workerHash = createHash('sha256').update(await readFile(worker)).digest('hex');
const forceImeOff = !args.includes('--keep-ime');
const manualMotion = args.includes('--manual-motion');
const only = option('--only')?.split(',');
const nonce = randomBytes(8).toString('hex');
const directory = join(root, 'work', `live-v2-${Date.now()}-${nonce}`);
await mkdir(directory, {recursive:true});

const fixture = new Fixture({root, directory, nonce});
const client = new Client({name:'human-input-visible-acceptance', version:'0.2.0'}, {capabilities:{}});
const environment = {...process.env, HUMAN_INPUT_WORKER:worker};
delete environment.NODE_OPTIONS;
delete environment.NODE_PATH;
const transport = new StdioClientTransport({command:process.execPath, args:[join(root,'server.mjs')], env:environment, stderr:'pipe'});
let serverDiagnostics = '';
transport.stderr?.on('data', b => { serverDiagnostics = (serverDiagnostics + b).slice(-8192); });
const cases = [];
const receipts = [];
const cleanup = {};
let connected = false, aborted;

async function call(name, arguments_ = {}, {allowError = false} = {}) {
  if (forceImeOff && name === 'human_type') arguments_ = {...arguments_, force_ime_off:true};
  const raw = await client.callTool({name, arguments:arguments_});
  const value = JSON.parse(raw.content.find(c => c.type === 'text').text);
  // Product never returns clipboard text; arguments contain only known fixture values.
  receipts.push({name, at:Date.now(), arguments:arguments_, result:value, isError:!!raw.isError});
  if (raw.isError && !allowError) {
    const code = value.error?.code ?? value.code ?? value.error_code ?? 'tool_error';
    const error = new Error(`${name}: ${code}${value.error?.message ? ` (${value.error.message})` : ''}`);
    error.code = code;
    throw error;
  }
  return allowError ? {value, isError:!!raw.isError} : value;
}

// Every case starts from: no active work, mode on. Cases never depend on a
// previous case's receiver text; `needs` only records an explicit prerequisite.
async function testCase(name, run, {needs = []} = {}) {
  if (only && !only.includes(name)) return;
  const record = {name, status:'inconclusive', started_at:Date.now()}; cases.push(record);
  const blocker = needs.find(n => cases.find(c => c.name === n)?.status !== 'passed');
  if (aborted) Object.assign(record, {status:'not_run', reason:`aborted: ${aborted}`});
  else if (blocker) Object.assign(record, {status:'blocked', reason:`needs ${blocker}`});
  else {
    process.stdout.write(`  ${name} ... `);
    const physicalBefore = (await fixture.fresh()).canvas.physical_inputs;
    try {
      await fixture.phase(name, `Running: ${name}. Do not touch the mouse or keyboard.`);
      const stop = await call('human_stop');
      if (stop.cleanup_confirmed === false) throw Object.assign(new Error('human_stop cleanup unconfirmed'), {fatal:true});
      if (!(await call('human_mode')).enabled) await call('human_mode', {enabled:true});
      record.evidence = await run();
      record.status = 'passed';
    } catch (error) {
      Object.assign(record, classifyAcceptanceError(error));
      record.reason = error.message;
      if (error.fatal) aborted = error.message;
    }
    // A person moving the mouse, or another window covering the receiver,
    // invalidates a case; the product pausing on it is correct.
    const end = await fixture.fresh();
    const physical = end.canvas.physical_inputs - physicalBefore;
    const occluders = Object.entries(end.occluders ?? {}).filter(([, v]) => v);
    if (physical > 0) record.physical_inputs = physical;
    if (occluders.length) record.occluders = Object.fromEntries(occluders);
    if (record.status === 'failed' && occluders.length) {
      Object.assign(record, {status:'inconclusive', category:'occluded_by_other_window',
        reason:`receiver covered by ${[...new Set(occluders.map(([, v]) => v))].join(', ')}: ${record.reason}`});
    } else if (record.status === 'failed' && !manualMotion && (physical > 0 || /pointer_anomaly|pointer_takeover/.test(record.reason))) {
      Object.assign(record, {status:'inconclusive', category:'physical_interference',
        reason:`physical mouse input during the case (${physical} receiver events): ${record.reason}`});
    }
    console.log(record.status === 'passed' ? 'PASS' : `${record.status.toUpperCase()} — ${record.reason}`);
  }
  record.finished_at = Date.now();
}
function skip(name, reason, status = 'skipped') { if (!only || only.includes(name)) cases.push({name, status, reason}); }

async function observe({focus, activation = false, parking = false} = {}) {
  const state = await fixture.fresh();
  const target = parking ? state.parking : state.receiver;
  const observation = await call('human_observe', {hwnd:target.hwnd});
  validateObservation(target, observation, {focus:focus ? state[focus].hwnd : undefined, activation});
  return {state, observation, hwnd:target.hwnd};
}
function point(rect, x = .5, y = .5) { return {x:Math.round(rect.x + rect.width*x), y:Math.round(rect.y + rect.height*y)}; }
function inset(rect, by = 6) { return {x:rect.x+by, y:rect.y+by, width:rect.width-2*by, height:rect.height-2*by}; }
async function input(name, arguments_ = {}, options = {}) {
  const {source, ...observationOptions} = options;
  const fresh = await observe(observationOptions);
  if (['x','y','safe_area','segments'].some(field => Object.hasOwn(arguments_,field))) {
    validateCoordinateSource(source,fresh.state);
  }
  const result = await call(name, {hwnd:fresh.hwnd, ...arguments_});
  assert.equal(result.state, 'completed', `${name} ended ${result.state} (${result.reason ?? result.error?.code})`);
  assert.equal(result.cleanup_confirmed, true, 'Full admitted native cleanup receipt missing');
  assert.equal(result.deliveryVerified, false);
  return {before:fresh.state, result, after:await fixture.fresh()};
}
// Uses the product's own guarded safe click on a neutral pad; no focus APIs.
async function activate(window, pad) {
  const state = await fixture.fresh();
  const area = inset(state[pad].rect);
  const result = await call('human_activate', {hwnd:state[window].hwnd, ...point(area), safe_area:area,
    safe_area_confirmed:true, duration_ms:600});
  assert.equal(result.state, 'completed', `human_activate ended ${result.state} (${result.reason ?? result.error?.code})`);
  assert.equal(result.cleanup_confirmed, true);
  return {before:state, result, after:await fixture.fresh()};
}
// Pointer paths never leave the target client, so the cursor must already be
// inside it; human_activate is the only tool that may enter from outside.
async function ensureReceiverForeground() {
  const state = await fixture.fresh();
  const observation = await call('human_observe', {hwnd:state.receiver.hwnd});
  const c = observation.client, p = observation.cursor;
  const inside = p.x >= c.x && p.y >= c.y && p.x < c.x + c.width && p.y < c.y + c.height;
  if (!observation.ready || !inside) await activate('receiver', 'activation');
}
async function focusEditor(editor) {
  await ensureReceiverForeground();
  const {state} = await observe();
  if (state.focus === state[editor].hwnd) return;
  await input('human_mouse_click', {...point(state[editor].rect), duration_ms:400}, {source:state});
  await waitFor(async () => (await fixture.fresh()).focus === state[editor].hwnd, `${editor} focus`, 3000);
}
async function expectText(editor, expected) {
  const state = await waitFor(async () => {
    const current = await fixture.read();
    return current && current[editor].matches[expected] ? current : false;
  }, `${editor} to contain the known ${expected} value`, 5000);
  return knownTextEvidence(state[editor], expected);
}
async function key(key_, editor, modifiers = []) {
  return input('human_key', {key:key_, modifiers}, {focus:editor});
}
async function clearEditor(editor) {
  await focusEditor(editor);
  if ((await fixture.fresh())[editor].matches.empty) return;
  await key('a', editor, ['ctrl']); await key('delete', editor);
  await expectText(editor, 'empty');
}
function readingArgs(state, duration = 8000) {
  const c = state.canvas.rect;
  return {hwnd:state.receiver.hwnd, segments:[{region_id:'fresh-canvas',
    rect:{x:c.x+15,y:c.y+45,width:c.width-30,height:c.height-60},
    purpose:'Isolated visible acceptance pure movement',direction:'left_to_right',duration_ms:duration}]};
}
async function startReading(duration = 8000) {
  await ensureReceiverForeground();
  const {state} = await observe();
  const result = await call('reading_start', readingArgs(state,duration));
  assert.ok(result.operation_id);
  assert.equal(result.state,'running');
  return {result, before:state};
}
// Receiver input is delivered asynchronously after SendInput returns, so counts
// are read once they reach the expected value, then re-read to prove exactness.
async function settled(predicate, description, timeout = 2000) {
  await waitFor(async () => { const s = await fixture.fresh(); return predicate(s) ? s : false; }, description, timeout);
  await delay(150);
  return fixture.fresh();
}
// A snapshot guaranteed to be written after the caller's ack: the first fresh
// read may predate it, the second is written after that read.
async function postAck() { await fixture.fresh(); return fixture.fresh(); }
async function stableAfterBarrier(baseline, milliseconds = 300) {
  // Input injected before the barrier may still be queued; what must not exist is
  // input generated after it. Windows stamps each message with its creation time.
  await delay(milliseconds);
  const next = await fixture.fresh();
  const late = (next.canvas.last_injected_tick - baseline.tick) | 0;
  assert.ok(late <= 0, `worker input generated ${late} ms after the barrier`);
  assert.equal(next.changes,baseline.changes);
  return {barrier_tick:baseline.tick, last_injected_tick:next.canvas.last_injected_tick, checked_sequence:next.sequence};
}
async function countdown(seconds, message) {
  for (let s = seconds; s > 0; s--) { process.stdout.write(`\r${message} ${s}s `); await delay(1000); }
  process.stdout.write('\n');
}

try {
  console.log(`Human Input visible acceptance ${nonce}`);
  console.log(`worker ${worker}\nsha256 ${workerHash}\nevidence ${directory}`);
  await countdown(5, 'Two test windows will open and the mouse/keyboard will be driven. Hands off in');
  fixture.launch();
  const launched = await fixture.fresh();
  cases.push({name:'visible_launch', status:'passed', evidence:{pid:launched.pid,receiver:launched.receiver,parking:launched.parking}});
  console.log('  visible_launch ... PASS');
  await client.connect(transport); connected = true;
  const capabilities = await call('human_capabilities');
  assert.equal(capabilities.protocol,2); assert.equal(capabilities.version,'0.2.0');
  assert.equal(capabilities.agent_push_supported,false);
  assert.equal((await call('human_mode')).enabled,false, 'New process must start with mode off');

  await testCase('safe_foreground_activation', async () => {
    // Move foreground to this run's parking window, then take it back with one neutral click.
    const parked = await activate('parking', 'park');
    const parkedState = await settled(s => s.park.ups > parked.before.park.ups, 'parking pad click');
    assert.equal(parkedState.park.downs - parked.before.park.downs, 1);
    const {state, observation} = await observe({activation:true});
    assert.equal(observation.foreground, state.parking.hwnd, 'Parking must be foreground before the activation case');
    const activated = await activate('receiver', 'activation');
    assert.equal(activated.result.foreground_observed, true);
    await settled(s => s.activation.ups > state.activation.ups, 'activation pad click');
    const after = (await observe()).state;
    assert.equal(after.activation.downs - state.activation.downs, 1);
    assert.equal(after.activation.ups - state.activation.ups, 1);
    assert.equal(after.changes, state.changes);
    assert.equal(after.canvas.clicks, state.canvas.clicks);
    return {native:activated.result, activation:after.activation};
  });
  await testCase('typing_unicode_and_full_status_wire', async () => {
    await clearEditor('a');
    const typed = await input('human_type',{text:'Hi 4!字',wpm:90,seed:42},{focus:'a'});
    return {receiver:await expectText('a','typed'),native:typed.result};
  });
  await testCase('explicit_keys_selection_navigation_enter', async () => {
    await focusEditor('a');
    assert.ok((await fixture.fresh()).a.matches.typed, 'editor A must hold the typed value from the typing case');
    await key('a','a',['ctrl']);
    assert.equal((await settled(s => s.a.selection_length > 0, 'Ctrl+A selection')).a.selection_length,6);
    await key('end','a');
    assert.equal((await settled(s => s.a.selection_length === 0, 'End clears selection')).a.selection_start,6);
    await key('enter','a'); await expectText('a','newline');
    await key('backspace','a');
    return {receiver:await expectText('a','typed'),key_evidence:(await fixture.fresh()).keys};
  }, {needs:['typing_unicode_and_full_status_wire']});
  await testCase('canvas_click_and_drag', async () => {
    await ensureReceiverForeground();
    const {state} = await observe();
    const clicked = await input('human_mouse_click',{...point(state.canvas.rect,.2,.65),duration_ms:500},{source:state});
    const afterClick = await settled(s => s.canvas.clicks > clicked.before.canvas.clicks, 'canvas click');
    assert.equal(afterClick.canvas.clicks-clicked.before.canvas.clicks,1);
    const fresh = await observe();
    const dragged = await input('human_mouse_drag',{...point(fresh.state.canvas.rect,.8,.65),duration_ms:900},{source:fresh.state});
    const afterDrag = await settled(s => s.canvas.ups > dragged.before.canvas.ups, 'drag release');
    assert.equal(afterDrag.canvas.downs-dragged.before.canvas.downs,1);
    assert.equal(afterDrag.canvas.ups-dragged.before.canvas.ups,1);
    assert.equal(afterDrag.canvas.drops-dragged.before.canvas.drops,1);
    assert.ok(afterDrag.canvas.drag_moves>dragged.before.canvas.drag_moves);
    return {before:dragged.before.canvas,after:afterDrag.canvas};
  });
  for (const [axis,delta] of [['vertical',240],['horizontal',120],['vertical',-120]]) {
    await testCase(`wheel_${axis}_${delta}`, async () => {
      await ensureReceiverForeground();
      const s = (await observe()).state;
      await input('human_mouse_move',{...point(s.canvas.rect,.7,.65),duration_ms:400},{source:s});
      const outcome = await input('human_scroll',{axis,delta});
      const packets = Math.abs(delta)/120;
      const after = await settled(s => s.canvas.wheel_count - outcome.before.canvas.wheel_count >= packets, 'wheel packets');
      assert.equal(after.canvas[axis]-outcome.before.canvas[axis],delta);
      assert.equal(after.canvas.wheel_count-outcome.before.canvas.wheel_count,packets);
      return {delta,packets,before:outcome.before.canvas,after:after.canvas};
    });
  }
  if (!only || only.includes('clipboard_copy_cut_paste')) {
    const clipboard = await fixture.command('clipboard_prepare', {allow_discard:args.includes('--discard-clipboard')});
    if (!clipboard.ok) skip('clipboard_copy_cut_paste',`Clipboard cannot be backed up (${clipboard.clipboard}); copy plain text first or pass --discard-clipboard`);
    else await testCase('clipboard_copy_cut_paste', async () => {
      await clearEditor('a'); await clearEditor('b');
      await focusEditor('a');
      await input('human_type',{text:`clip-${nonce}`,wpm:180},{focus:'a'});await expectText('a','token');
      await key('a','a',['ctrl']);
      assert.equal((await fixture.command('clipboard_check')).ok,true,'clipboard changed by someone else');
      let sequence = (await fixture.fresh()).clipboard_sequence;
      await input('human_copy',{}, {focus:'a'});
      assert.equal((await fixture.command('clipboard_accept_write',{before:sequence})).ok,true,'copy did not place the token on the clipboard');
      await expectText('a','token');
      await focusEditor('b');
      await input('human_paste',{}, {focus:'b'});await expectText('b','token');
      await focusEditor('a');await key('a','a',['ctrl']);
      assert.equal((await fixture.command('clipboard_check')).ok,true,'clipboard changed by someone else');
      sequence = (await fixture.fresh()).clipboard_sequence;
      await input('human_cut',{}, {focus:'a'});
      assert.equal((await fixture.command('clipboard_accept_write',{before:sequence})).ok,true,'cut did not place the token on the clipboard');
      await expectText('a','empty');
      await focusEditor('b');await key('end','b');
      await input('human_paste',{}, {focus:'b'});await expectText('b','double_token');
      const restored = await fixture.command('clipboard_restore');assert.equal(restored.ok,true,'clipboard restore failed');
      return {a:await expectText('a','empty'),b:await expectText('b','double_token'),restoration:restored.clipboard};
    });
  }
  await testCase('reading_readonly_cancel_barrier', async () => {
    const startedAt = performance.now();const run = await startReading(12000);
    const admissionMs = performance.now()-startedAt;
    const timer = await call('timer_attach',{target_id:'fixture',section_id:'readonly'});
    const queried = ['human_status','reading_status','human_observe','human_events','human_mode','human_capabilities','timer_status'];
    await call('human_status',{operation_id:run.result.operation_id});
    await call('reading_status',{operation_id:run.result.operation_id});
    await observe();await call('human_events');await call('human_mode');await call('human_capabilities');
    await call('timer_status',{timer_id:timer.timer_id});
    await call('timer_detach',{timer_id:timer.timer_id});
    const active = await call('reading_status',{operation_id:run.result.operation_id});assert.equal(active.state,'running','read-only calls must not cancel reading');
    const moving = await settled(s => s.canvas.moves > run.before.canvas.moves, 'reading pointer movement', 3000);
    assert.equal(moving.canvas.clicks,run.before.canvas.clicks);assert.equal(moving.changes,run.before.changes);
    assert.equal((await call('reading_status',{operation_id:run.result.operation_id})).state,'running');
    const barrier = await call('reading_cancel',{operation_id:run.result.operation_id});assert.equal(barrier.cleanup_confirmed,true);
    const stable = await stableAfterBarrier(await postAck());
    return {admission_ms:admissionMs,queried,barrier,stable};
  });
  await testCase('reading_explicit_pause_resume', async () => {
    const run = await startReading(8000);await delay(350);
    const paused = await call('human_pause',{operation_id:run.result.operation_id});
    assert.equal(paused.state,'paused');assert.equal(paused.cleanup_confirmed,true);
    const baseline = await postAck();await stableAfterBarrier(baseline);
    const blockedTarget = await observe();
    const blocked = await call('human_mouse_move',{hwnd:blockedTarget.hwnd,...point(blockedTarget.state.canvas.rect)},{allowError:true});
    assert.equal(blocked.isError,true,'new input must be refused while paused');
    await observe();
    const resumed = await call('human_resume',{operation_id:run.result.operation_id,pause_revision:paused.pause_revision,external_checked:true,resolution:{type:'continue'}});
    assert.ok(['running','resuming','completed'].includes(resumed.state));
    await settled(s => s.canvas.moves > baseline.canvas.moves, 'movement after resume', 3000);
    const stopped = await call('human_stop');assert.equal(stopped.cleanup_confirmed,true);
    return {paused,resumed,stopped};
  });
  await testCase('new_input_cancels_reading', async () => {
    const run = await startReading(10000);await delay(250);
    const s = (await observe()).state;
    const click = await input('human_mouse_click',{...point(s.canvas.rect,.3,.6),duration_ms:500},{source:s});
    const old = await call('reading_status',{operation_id:run.result.operation_id});
    assert.equal(old.state,'cancelled');assert.equal(old.cleanup_confirmed,true);
    const after = await settled(s => s.canvas.clicks > click.before.canvas.clicks, 'click after reading');
    assert.equal(after.canvas.clicks-click.before.canvas.clicks,1);
    return {old_reading:old,new_input:click.result};
  });
  for (const control of ['stop','mode_off']) {
    await testCase(`${control}_while_paused`, () => exercisePausedControl({
      control,startReading,call,fresh:postAck,stableAfterBarrier,settle:() => delay(200),
    }));
  }
  skip('live_mid_hold_keyboard_drag_clipboard','Interrupting mid key/drag/clipboard hold is covered by deterministic native tests only.','not_covered');
  if (manualMotion) {
    for (const kind of ['small','takeover']) {
      await testCase(`manual_pointer_${kind}`, async () => {
        const instruction = kind==='small'
          ? 'When the cursor starts sweeping the canvas, nudge the mouse ONCE by about 2-4 cm, then let go.'
          : 'When the cursor starts sweeping the canvas, move the mouse back and forth widely for about 1 second.';
        console.log(`\n  >>> ${instruction}`);
        await fixture.phase(`manual_${kind}`, instruction);
        await countdown(3, '  scan starts in');
        const run = await startReading(20000);
        const events = await waitFor(async () => {
          const e = await call('human_events');
          const list = e.events.filter(item=>item.operation_id===run.result.operation_id);
          return list.some(item=>item.event===(kind==='small'?'auto_resumed':'pointer_takeover')) ? list : false;
        },`physical ${kind} evidence`,18000);
        const status = await call('reading_status',{operation_id:run.result.operation_id});
        if(kind==='takeover')assert.equal(status.state,'paused');
        await call('human_stop');return {events,status,threshold_px:8};
      });
    }
  } else {
    skip('manual_pointer_small','Needs a person to move the mouse; rerun with --manual-motion.');
    skip('manual_pointer_takeover','Needs a person to move the mouse; rerun with --manual-motion.');
  }
} catch (error) {
  aborted = error.message;
  console.error(`\nAcceptance aborted: ${error.message}`);
} finally {
  if (!connected) cleanup.input_confirmed = true; // No input request can precede MCP connection.
  if (connected) {
    try {cleanup.stop=await call('human_stop');cleanup.input_confirmed=cleanup.stop.idle===true||cleanup.stop.state==='idle'||cleanup.stop.cleanup_confirmed===true;}
    catch(error){cleanup.stop_error=error.message;cleanup.input_confirmed=false;}
    try {await call('human_mode',{enabled:false});}catch(error){cleanup.mode_error=error.message;}
  }
  try {cleanup.clipboard=await fixture.command('clipboard_restore');}catch(error){cleanup.clipboard_error=error.message;}
  try {await client.close();cleanup.transport_closed=true;}catch(error){cleanup.transport_error=error.message;}
  if(cleanup.input_confirmed&&cleanup.clipboard?.ok) {
    try {cleanup.fixture_exit=await fixture.close();}catch(error){cleanup.fixture_error=error.message;}
  }
  if (!cleanup.fixture_exit && fixture.child) {
    cleanup.fixture_retained=true;
    fixture.detachRetained();
    console.error('Fixture window left open because cleanup could not be confirmed. Close it manually.');
  }
  const counts = {};
  for (const c of cases) counts[c.status] = (counts[c.status] ?? 0) + 1;
  const cleanupOk = !(Object.values(cleanup).some(v=>v===false)||cleanup.fixture_error||cleanup.clipboard_error||cleanup.transport_error||cleanup.stop_error);
  const report={version:'0.2.0',protocol:2,nonce,directory,node:process.version,worker,worker_sha256:workerHash,force_ime_off:forceImeOff,
    summary:counts,aborted,cases,cleanup,cleanup_ok:cleanupOk,receipts,server_diagnostics:serverDiagnostics,fixture_diagnostics:fixture.diagnostics,
    agent_push_supported:false,scope:'Run-owned WinForms receiver only; completed is not delivery verification for other apps.'};
  await writeFile(join(directory,'verification.json'),JSON.stringify(report,null,2));
  console.log('\nResult');
  for (const c of cases) console.log(`  ${c.status.padEnd(13)} ${c.name}${c.status==='passed'?'':` — ${c.reason}`}`);
  console.log(`  cleanup       ${cleanupOk?'ok':'FAILED '+JSON.stringify(cleanup)}`);
  console.log(`\n${Object.entries(counts).map(([k,v])=>`${k} ${v}`).join(', ')}\nEvidence: ${join(directory,'verification.json')}`);
  process.exitCode = (aborted || !cleanupOk || cases.some(c=>c.status==='failed')) ? 1 : 0;
}
