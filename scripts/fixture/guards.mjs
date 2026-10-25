import assert from 'node:assert/strict';

export function validateSnapshot(state, {nonce, pid, after = -1}) {
  assert.equal(state.nonce, nonce, 'Fixture run nonce differs');
  assert.equal(state.pid, pid, 'Fixture process differs');
  assert.ok(Number.isSafeInteger(state.sequence) && state.sequence > after, 'Stale fixture sequence');
  assert.equal(state.shown, true, 'Fixture Shown not acknowledged');
  for (const window of [state.receiver, state.parking]) {
    assert.equal(window.visible, true, 'Fixture is hidden');
    assert.equal(window.enabled, true);
    assert.equal(window.window_state, 'Normal');
    assert.ok(window.client.width > 0 && window.client.height > 0 && window.dpi > 0);
  }
  return state;
}

export function validateObservation(fixture, observation, {focus, activation = false} = {}) {
  for (const field of ['hwnd', 'identity', 'dpi', 'rect', 'client']) {
    assert.deepEqual(observation[field], fixture[field], `Physical ${field} disagrees`);
  }
  assert.equal(observation.visible, true);
  assert.equal(observation.enabled, true);
  if (activation) return;
  assert.equal(observation.ready, true);
  assert.equal(observation.foreground, fixture.hwnd);
  if (focus) assert.equal(observation.focus, focus, 'Intended editor must have focus');
  return observation;
}

export function knownTextEvidence(editor, expectation) {
  return {expected: expectation, length: editor.length, matches: editor.matches[expectation] === true};
}

export function classifyAcceptanceError(error) {
  if (/^Timed out: physical /.test(error.message)) {
    return {status:'inconclusive', category:'manual_movement_not_demonstrated'};
  }
  return {status:'failed', category:'verification_error'};
}

export function validateCoordinateSource(source, current) {
  assert.ok(source, 'Coordinate source snapshot is required');
  for (const field of ['nonce','pid']) assert.equal(source[field],current[field],`Coordinate source ${field} differs`);
  for (const field of ['hwnd','identity','dpi','rect','client']) {
    assert.deepEqual(source.receiver[field],current.receiver[field],`Coordinate source geometry ${field} changed; reobserve and replan`);
  }
  for (const control of ['a','b','canvas','activation']) {
    assert.deepEqual(source[control]?.rect,current[control]?.rect,`Coordinate source ${control} geometry changed; reobserve and replan`);
  }
}
