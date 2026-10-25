import assert from 'node:assert/strict';
import {spawn as spawnChild} from 'node:child_process';
import {readFile, writeFile, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateSnapshot} from './guards.mjs';

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function waitFor(check, description, timeout = 10000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out: ${description}`);
}

export class Fixture {
  constructor({root, directory, nonce, commandTimeout = 10000, closeTimeout = 10000, spawn = spawnChild}) {
    Object.assign(this, {root, directory, nonce, commandTimeout, closeTimeout, spawn});
    this.sequence = -1;
    this.commandId = 0;
    this.diagnostics = '';
  }
  launch() {
    const relay=fileURLToPath(new URL('./relay.mjs',import.meta.url));
    this.child = this.spawn(process.execPath, [relay,this.nonce,'powershell.exe','-NoProfile', '-STA', '-WindowStyle', 'Normal',
      '-ExecutionPolicy', 'Bypass', '-File', join(this.root, 'scripts/test-window.ps1'),
      '-StatePath', join(this.directory, 'fixture.json'), '-Nonce', this.nonce],
    // Direct detached PowerShell can exit 0 before running its script on Windows.
    {windowsHide:false, detached:true, stdio:['ignore', 'pipe', 'pipe', 'ipc']});
    this.child.stdout.on('data',()=>{});
    this.child.stderr.on('data', chunk => { this.diagnostics = (this.diagnostics + chunk).slice(-8192); });
    this.child.on('message',message=>{
      if (message?.nonce!==this.nonce) {this.spawnError='Fixture relay nonce mismatch';return;}
      if (message.type==='started' && Number.isInteger(message.pid) && message.pid>0 && !this.pid) this.pid=message.pid;
      else if (message.type==='spawn_error') this.spawnError=message.message;
      else if (message.type==='exited') this.helperExitResult={code:message.code,signal:message.signal};
      else this.spawnError='Invalid fixture relay lifecycle message';
    });
    this.child.once('error', error => { this.spawnError = error.message; });
    this.exit = new Promise(resolve => this.child.once('exit', (code, signal) => {
      this.exitResult = this.helperExitResult ?? {code, signal}; resolve(this.exitResult);
    }));
  }
  async read() {
    assert.ok(!this.spawnError, `Fixture spawn failed: ${this.spawnError}`);
    assert.ok(!this.exitResult, `Fixture exited unexpectedly: ${JSON.stringify(this.exitResult)} ${this.diagnostics}`);
    assert.ok(!this.helperExitResult, `Fixture exited unexpectedly: ${JSON.stringify(this.helperExitResult)} ${this.diagnostics}`);
    if (!this.pid) return null;
    let state;
    try { state = JSON.parse(await readFile(join(this.directory, 'fixture.json'), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EBUSY' || error.code === 'EACCES') return null;
      throw new Error(`Fixture snapshot read failed: ${error.code ?? error.name}`);
    }
    if (!state.shown || state.sequence <= this.sequence) return null;
    validateSnapshot(state, {nonce:this.nonce, pid:this.pid, after:this.sequence});
    assert.equal(state.command_error, null, 'Fixture lifecycle command failed');
    this.sequence = state.sequence;
    return state;
  }
  fresh() { return waitFor(() => this.read(), 'fresh run-bound fixture snapshot'); }
  async command(action, fields = {}) {
    const id = ++this.commandId;
    const temporary = join(this.directory, 'command.tmp');
    await writeFile(temporary, JSON.stringify({nonce:this.nonce, id, action, ...fields}));
    // Windows refuses to replace a file the fixture is reading at that moment.
    const busy = error => ['EPERM', 'EBUSY', 'EACCES'].includes(error.code);
    await waitFor(async () => {
      try { await rename(temporary, join(this.directory, 'command.json')); return true; }
      catch (error) { if (busy(error)) return false; throw error; }
    }, `fixture command ${action} delivery`, 2000);
    return waitFor(async () => {
      let ack;
      try { ack = JSON.parse(await readFile(join(this.directory, 'ack.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || busy(error)) return false; throw error; }
      return ack.nonce === this.nonce && ack.id === id ? ack : false;
    }, `fixture command ${action}`, this.commandTimeout);
  }
  // Shows the current case in the receiver window; never waits for a person.
  async phase(phase, instruction) {
    assert.equal((await this.command('phase', {phase, instruction})).ok, true);
  }
  async close() {
    try {
      const ack = await this.command('close');
      assert.equal(ack.ok, true, 'Fixture retains clipboard backup; close refused');
      const result = await waitFor(() => this.exitResult, 'graceful fixture process exit', this.closeTimeout);
      assert.equal(result.code,0,'Fixture process exited unsuccessfully');
      return result;
    } catch (error) {
      this.detachRetained();
      throw error;
    }
  }
  detachRetained() {
    this.retained = true;
    this.child?.unref();
    this.child?.channel?.unref();
    for (const stream of [this.child?.stdin,this.child?.stdout,this.child?.stderr]) stream?.unref?.();
  }
}
