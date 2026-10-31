import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { processStartTime, isAlive, effectiveState, isFinal } from '../plugins/crewmate/lib/liveness.mjs';
import { waitFor } from './helpers.mjs';

function sleeper() {
  const child = spawn('sleep', ['30']);
  return child;
}

test('a live child with its real start time is alive; a different start time is not', () => {
  const c = sleeper();
  const startTime = processStartTime(c.pid);
  assert.ok(startTime, 'start time read');
  assert.equal(isAlive({ pid: c.pid, startTime }), true);
  assert.equal(isAlive({ pid: c.pid, startTime: 'Thu Jan  1 00:00:00 1970' }), false);
  assert.equal(isAlive(null), false);
  c.kill('SIGKILL');
});

test('a killed child is not alive', async () => {
  const c = sleeper();
  const startTime = processStartTime(c.pid);
  c.kill('SIGKILL');
  await new Promise((r) => c.on('exit', r));
  await waitFor(() => processStartTime(c.pid) === null, 2000);
  assert.equal(isAlive({ pid: c.pid, startTime }), false);
});

const base = { state: 'running', reason: null, createdAt: new Date().toISOString(), runner: null };

test('effectiveState: running job with a dead runner is failed / runner died', () => {
  const s = effectiveState({ ...base, runner: { pid: 999999, startTime: 'x' } });
  assert.deepEqual(s, { state: 'failed', reason: 'runner died' });
});

test('effectiveState: queued job with no runner is queued within the spawn grace, failed after', () => {
  const now = Date.now();
  const job = { ...base, state: 'queued', createdAt: new Date(now - 1000).toISOString() };
  assert.equal(effectiveState(job, now, {}).state, 'queued');
  const old = { ...job, createdAt: new Date(now - 11_000).toISOString() };
  assert.deepEqual(effectiveState(old, now, {}), { state: 'failed', reason: 'runner never started' });
  assert.equal(effectiveState(old, now, { CREWMATE_SPAWN_GRACE_MS: '20000' }).state, 'queued');
});

test('effectiveState: final states are returned as stored', () => {
  assert.deepEqual(effectiveState({ ...base, state: 'done', reason: null }), { state: 'done', reason: null });
  assert.equal(isFinal({ ...base, state: 'timeout' }), true);
  assert.equal(isFinal({ ...base, state: 'queued' }), false);
});
