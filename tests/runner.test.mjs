// Spec §4.11 failure modes (T-numbers are spec ids, not a sequence).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveWorkspace } from '../plugins/crewmate/lib/workspace.mjs';
import { createJob, readJob, jobDir, writeJob } from '../plugins/crewmate/lib/jobs.mjs';
import { effectiveState } from '../plugins/crewmate/lib/liveness.mjs';
import { readEvents } from '../plugins/crewmate/lib/events.mjs';
import { spawnRunner } from '../plugins/crewmate/lib/runner.mjs';
import { acquireWriter, releaseWriter } from '../plugins/crewmate/lib/lock.mjs';
import { FIXTURES, fakePath, tempDir, tempHome, waitFor } from './helpers.mjs';

const FINAL = ['done', 'failed', 'timeout', 'canceled'];

function startJob(vendor, { flags = {}, env = {}, fakes, prompt = 'hello' } = {}) {
  const { home } = tempHome();
  const w = resolveWorkspace(tempDir(), { CREWMATE_HOME: home });
  const job = createJob(w, { vendor, kind: 'ask', promptSummary: 'p', flags: { timeoutMs: 10_000, ...flags } });
  fs.writeFileSync(path.join(jobDir(w, job.id), 'prompt.txt'), prompt);
  const PATH = fakePath(fakes ?? [vendor === 'codex' ? 'codex' : 'agy']);
  spawnRunner(w, job.id, { PATH, HOME: home, CREWMATE_HOME: home, ...env });
  return { w, id: job.id, home };
}

function fixture(name) {
  return path.join(FIXTURES, name);
}

async function finalOf(w, id, ms = 10_000) {
  return waitFor(() => {
    const j = readJob(w, id);
    if (!j) return null;
    const s = effectiveState(j);
    return FINAL.includes(s.state) ? { ...j, ...s } : null;
  }, ms);
}

function groupGone(pid) {
  try {
    process.kill(-pid, 0);
    return false;
  } catch {
    return true;
  }
}

test('happy path: codex.ndjson ends done with the answer in result.md and an end event', async () => {
  const { w, id } = startJob('codex', { env: { FAKE_FIXTURE: fixture('codex.ndjson'), FAKE_ANSWER: 'the answer' } });
  const j = await finalOf(w, id);
  assert.equal(j.state, 'done');
  assert.equal(fs.readFileSync(path.join(jobDir(w, id), 'result.md'), 'utf8'), 'the answer');
  assert.equal(j.vendorConversationId, '01a193d0-87dd-7341-9392-cbf04ee3bb21');
  const ev = readEvents(jobDir(w, id));
  assert.equal(ev[0].type, 'started');
  assert.equal(ev.at(-1).type, 'end');
  assert.deepEqual(ev.map((e) => e.n), ev.map((_, i) => i + 1));
});

test('(T1) vendor exits non-zero → failed', async () => {
  const { w, id } = startJob('codex', { env: { FAKE_FIXTURE: fixture('codex.ndjson'), FAKE_EXIT: '2' } });
  const j = await finalOf(w, id);
  assert.equal(j.state, 'failed');
  assert.match(j.reason, /exit 2/);
});

test('(T2) gemini SUCCESS with denied_actions and an answer → done, denials listed, live tool error', async () => {
  const { w, id } = startJob('gemini', { env: { FAKE_FIXTURE: fixture('agy-denied-with-answer.ndjson') } });
  const j = await finalOf(w, id);
  assert.equal(j.state, 'done');
  assert.deepEqual(j.outcome.deniedTools, ['RunCommand']);
  assert.ok(readEvents(jobDir(w, id)).some((e) => e.type === 'tool' && e.phase === 'error'));
  assert.equal(fs.readFileSync(path.join(jobDir(w, id), 'result.md'), 'utf8'), 'done');
});

test('(T3) gemini SUCCESS with an empty response → failed, vendor returned no answer', async () => {
  const { w, id } = startJob('gemini', { env: { FAKE_FIXTURE: fixture('agy2.ndjson') } });
  const j = await finalOf(w, id);
  assert.equal(j.state, 'failed');
  assert.match(j.reason, /^vendor returned no answer/);
});

test('(T4) codex non-zero command → done with one tool error', async () => {
  const { w, id } = startJob('codex', { env: { FAKE_FIXTURE: fixture('codex-tool-error.ndjson') } });
  const j = await finalOf(w, id);
  assert.equal(j.state, 'done');
  assert.equal(j.outcome.toolErrors.length, 1);
});

test('(T5) vendor prints nothing → failed at the first-model-event deadline, group gone', async () => {
  const { w, id } = startJob('codex', { env: { FAKE_HANG: '1', CREWMATE_FIRST_EVENT_MS: '300', CREWMATE_CANCEL_GRACE_MS: '300' } });
  const j = await finalOf(w, id);
  assert.equal(j.state, 'failed');
  assert.match(j.reason, /^vendor did not respond/);
  assert.ok(groupGone(j.vendorProcess.pid));
});

test('(T5b) gemini init + user_input only → failed (user_input is not a model event)', async () => {
  const { w, id } = startJob('gemini', {
    env: { FAKE_FIXTURE: fixture('agy-user-input-only.ndjson'), FAKE_HANG_AFTER: '3', CREWMATE_FIRST_EVENT_MS: '300', CREWMATE_CANCEL_GRACE_MS: '300' },
  });
  const j = await finalOf(w, id);
  assert.equal(j.state, 'failed');
  assert.match(j.reason, /^vendor did not respond/);
});

test('(T6) vendor hangs after starting → timeout at the job deadline, group gone', async () => {
  const { w, id } = startJob('codex', {
    flags: { timeoutMs: 500 },
    env: { FAKE_FIXTURE: fixture('codex.ndjson'), FAKE_HANG_AFTER: '3', CREWMATE_CANCEL_GRACE_MS: '300' },
  });
  const j = await finalOf(w, id);
  assert.equal(j.state, 'timeout');
  assert.ok(groupGone(j.vendorProcess.pid));
});

test('(T8) runner killed mid-job → failed / runner died', async () => {
  const { w, id } = startJob('codex', { env: { FAKE_FIXTURE: fixture('codex.ndjson'), FAKE_DELAY_MS: '300' } });
  const runner = await waitFor(() => readJob(w, id)?.runner);
  process.kill(runner.pid, 'SIGKILL');
  const j = await finalOf(w, id);
  assert.deepEqual([j.state, j.reason], ['failed', 'runner died']);
});

test('(T12) gemini permission_mode other than request-review → failed before any tool event', async () => {
  const { w, id } = startJob('gemini', { env: { FAKE_FIXTURE: fixture('agy-permission-auto.ndjson'), CREWMATE_CANCEL_GRACE_MS: '300' } });
  const j = await finalOf(w, id);
  assert.equal(j.state, 'failed');
  assert.match(j.reason, /permission mode is auto, expected request-review/);
  assert.ok(!readEvents(jobDir(w, id)).some((e) => e.type === 'tool'));
});

test('vendor binary cannot be started → failed, could not start codex', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'codex'), 'not executable', { mode: 0o644 });
  fs.symlinkSync(process.execPath, path.join(dir, 'node'));
  const { home } = tempHome();
  const w = resolveWorkspace(tempDir(), { CREWMATE_HOME: home });
  const job = createJob(w, { vendor: 'codex', kind: 'ask', promptSummary: 'p', flags: { timeoutMs: 5000 } });
  fs.writeFileSync(path.join(jobDir(w, job.id), 'prompt.txt'), 'x');
  spawnRunner(w, job.id, { PATH: `${dir}:/usr/bin:/bin`, CREWMATE_HOME: home, HOME: home });
  const j = await finalOf(w, job.id);
  assert.equal(j.state, 'failed');
  assert.match(j.reason, /^could not start codex/);
});

test('a write job releases the writer lock at its end', async () => {
  const { home } = tempHome();
  const w = resolveWorkspace(tempDir(), { CREWMATE_HOME: home });
  const job = createJob(w, { vendor: 'codex', kind: 'ask', promptSummary: 'p', flags: { timeoutMs: 5000, write: true } });
  fs.writeFileSync(path.join(jobDir(w, job.id), 'prompt.txt'), 'x');
  assert.deepEqual(acquireWriter(w, job.id), { ok: true });
  spawnRunner(w, job.id, { PATH: fakePath(['codex']), CREWMATE_HOME: home, HOME: home, FAKE_FIXTURE: fixture('codex.ndjson') });
  await finalOf(w, job.id);
  // released in the runner's finally, just after the final state is saved
  await waitFor(() => !fs.existsSync(path.join(w.stateDir, 'writer.lock')), 3000);
});

function lockWs() {
  const { home } = tempHome();
  const w = resolveWorkspace(tempDir(), { CREWMATE_HOME: home });
  fs.mkdirSync(w.stateDir, { recursive: true });
  return w;
}

test('acquireWriter: a fresh lock whose holder has no job.json yet blocks', () => {
  const w = lockWs();
  fs.writeFileSync(path.join(w.stateDir, 'writer.lock'), 'codex-new-aaaa');
  assert.deepEqual(acquireWriter(w, 'codex-me-bbbb'), { ok: false, holder: 'codex-new-aaaa' });
});

test('acquireWriter: a holder that is done is taken over', () => {
  const w = lockWs();
  const holder = createJob(w, { vendor: 'codex', kind: 'ask', promptSummary: 'p', flags: {} });
  writeJob(w, { ...holder, state: 'done' });
  fs.writeFileSync(path.join(w.stateDir, 'writer.lock'), holder.id);
  assert.deepEqual(acquireWriter(w, 'codex-me-bbbb'), { ok: true });
  assert.equal(fs.readFileSync(path.join(w.stateDir, 'writer.lock'), 'utf8'), 'codex-me-bbbb');
});

test('acquireWriter: an old lock with no job.json counts as dead', () => {
  const w = lockWs();
  const lock = path.join(w.stateDir, 'writer.lock');
  fs.writeFileSync(lock, 'codex-gone-aaaa');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  assert.deepEqual(acquireWriter(w, 'codex-me-bbbb', { CREWMATE_SPAWN_GRACE_MS: '100' }), { ok: true });
  releaseWriter(w, 'someone-else');
  assert.equal(fs.existsSync(lock), true, 'release by a non-holder is a no-op');
  releaseWriter(w, 'codex-me-bbbb');
  assert.equal(fs.existsSync(lock), false);
});

// ---- Checkpoint 2 review findings ----
import { runJob } from '../plugins/crewmate/lib/runner.mjs';
import { processStartTime } from '../plugins/crewmate/lib/liveness.mjs';
import { spawn as spawnProc } from 'node:child_process';

test('CP2-1: a grandchild that ignores SIGTERM is SIGKILLed with the group', async () => {
  const pidFile = path.join(tempDir(), 'gc.pid');
  const { w, id } = startJob('codex', {
    flags: { timeoutMs: 600 },
    env: { FAKE_FIXTURE: fixture('codex.ndjson'), FAKE_HANG_AFTER: '3', FAKE_GRANDCHILD_PID_FILE: pidFile, CREWMATE_CANCEL_GRACE_MS: '300' },
  });
  const j = await finalOf(w, id);
  assert.equal(j.state, 'timeout');
  const gc = Number(fs.readFileSync(pidFile, 'utf8'));
  await waitFor(() => processStartTime(gc) === null, 2000);
});

test('CP2-2: a vendor that exits 0 while a background child holds stdout ends done, not timeout', async () => {
  const t0 = Date.now();
  const { w, id } = startJob('codex', { flags: { timeoutMs: 3000 }, env: { FAKE_FIXTURE: fixture('codex.ndjson'), FAKE_BACKGROUND_HOLD: '5' } });
  const j = await finalOf(w, id);
  assert.equal(j.state, 'done');
  assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0}ms`);
});

test('CP2-3: _run on a job that is already final (or canceled before start) does nothing', async () => {
  const { home } = tempHome();
  const w = resolveWorkspace(tempDir(), { CREWMATE_HOME: home });
  const job = createJob(w, { vendor: 'codex', kind: 'ask', promptSummary: 'p', flags: { timeoutMs: 5000 } });
  fs.writeFileSync(path.join(jobDir(w, job.id), 'prompt.txt'), 'x');
  writeJob(w, { ...job, state: 'canceled', reason: 'canceled before start' });
  const log = path.join(tempDir(), 'argv.log');
  await runJob(w, job.id, { PATH: fakePath(['codex']), FAKE_FIXTURE: fixture('codex.ndjson'), FAKE_ARGV_LOG: log, CREWMATE_HOME: home });
  assert.equal(readJob(w, job.id).state, 'canceled');
  assert.equal(fs.existsSync(log), false, 'vendor never started');
});

test('CP2-4: a recoverable codex error before a completed turn and exit 0 → done', async () => {
  const { w, id } = startJob('codex', { env: { FAKE_FIXTURE: fixture('codex-reconnect.ndjson') } });
  const j = await finalOf(w, id);
  assert.equal(j.state, 'done', j.reason);
});

test('CP2-7: a non-zero exit reports the vendor stderr line', async () => {
  const { w, id } = startJob('codex', { env: { FAKE_FIXTURE: fixture('codex.ndjson'), FAKE_EXIT: '1', FAKE_STDERR: 'Error: Not logged in' } });
  const j = await finalOf(w, id);
  assert.equal(j.state, 'failed');
  assert.match(j.reason, /exit 1: Error: Not logged in/);
});

test('CP2-6: an error after the job is running ends it failed with an end event (not runner died)', async () => {
  const { home } = tempHome();
  const w = resolveWorkspace(tempDir(), { CREWMATE_HOME: home });
  const job = createJob(w, { vendor: 'codex', kind: 'ask', promptSummary: 'p', flags: { timeoutMs: 5000 } });
  // no prompt.txt: reading it throws
  spawnRunner(w, job.id, { PATH: fakePath(['codex']), CREWMATE_HOME: home, HOME: home });
  const j = await finalOf(w, job.id);
  assert.equal(j.state, 'failed');
  assert.notEqual(j.reason, 'runner died');
  assert.equal(readEvents(jobDir(w, job.id)).at(-1).type, 'end');
});

test('empty answer with denials names the denied tools in the reason', async () => {
  const { w, id } = startJob('gemini', { env: { FAKE_FIXTURE: fixture('agy2.ndjson') } });
  const j = await finalOf(w, id);
  assert.equal(j.reason, 'vendor returned no answer (denied: RunCommand)');
});

test('CP2-declined: the writer lock is not taken over while the dead holder\'s vendor still runs', () => {
  const w = lockWs();
  const victim = spawnProc('sleep', ['30'], { detached: true });
  const holder = createJob(w, { vendor: 'codex', kind: 'ask', promptSummary: 'p', flags: { write: true } });
  writeJob(w, { ...holder, state: 'running', runner: { pid: 999999, startTime: 'x' }, vendorProcess: { pid: victim.pid, startTime: processStartTime(victim.pid) } });
  fs.writeFileSync(path.join(w.stateDir, 'writer.lock'), holder.id);
  assert.equal(acquireWriter(w, 'codex-me-bbbb').ok, false);
  victim.kill('SIGKILL');
});

test('gemini: agy finished_reason print_timeout → timeout, not an empty answer', async () => {
  const { w, id } = startJob('gemini', { env: { FAKE_FIXTURE: fixture('agy-print-timeout.ndjson') } });
  const j = await finalOf(w, id);
  assert.equal(j.state, 'timeout');
  assert.match(j.reason, /print timeout/);
});

test('gemini: an empty answer after a denied tool continues the conversation once and uses that answer', async () => {
  const log = path.join(tempDir(), 'argv.log');
  const { w, id } = startJob('gemini', {
    env: { FAKE_FIXTURE: fixture('agy2.ndjson'), FAKE_FIXTURE_RESUME: fixture('agy-denied-with-answer.ndjson'), FAKE_ARGV_LOG: log },
  });
  const j = await finalOf(w, id);
  assert.equal(j.state, 'done', j.reason);
  assert.equal(fs.readFileSync(path.join(jobDir(w, id), 'result.md'), 'utf8'), 'done');
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 2);
  assert.ok(calls[1].join(' ').includes('--conversation 7d51723c-e9b2-4e89-859b-bfe94a357739'));
  assert.ok(readEvents(jobDir(w, id)).some((e) => e.type === 'note' && /continuing/.test(e.text)));
  assert.equal(readEvents(jobDir(w, id)).filter((e) => e.type === 'end').length, 1);
});

test('gemini: the continuation happens at most once', async () => {
  const log = path.join(tempDir(), 'argv.log');
  const { w, id } = startJob('gemini', { env: { FAKE_FIXTURE: fixture('agy2.ndjson'), FAKE_ARGV_LOG: log } });
  const j = await finalOf(w, id);
  assert.equal(j.state, 'failed');
  assert.match(j.reason, /^vendor returned no answer/);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 2);
});

test('lock: two contenders reclaiming the same stale lock never both succeed', async () => {
  const { home } = tempHome();
  const cwd = tempDir();
  const w = resolveWorkspace(cwd, { CREWMATE_HOME: home });
  fs.mkdirSync(w.stateDir, { recursive: true });
  const holder = createJob(w, { vendor: 'codex', kind: 'ask', promptSummary: 'p', flags: { write: true } });
  writeJob(w, { ...holder, state: 'done' });
  fs.writeFileSync(path.join(w.stateDir, 'writer.lock'), holder.id);
  // Staggered pauses: both check the stale holder; A unlinks and takes the lock at ~150 ms; B, still
  // holding its stale check, unlinks at ~700 ms. Without serialization B deletes A's fresh lock.
  const child = (me, pause) =>
    new Promise((resolve) => {
      const c = spawnProc(process.execPath, [path.join(FIXTURES, '..', 'lock-race.child.mjs'), cwd, me], {
        env: { ...process.env, CREWMATE_HOME: home, CREWMATE_LOCK_TEST_PAUSE_MS: String(pause) },
      });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.on('close', () => resolve(out));
    });
  const results = await Promise.all([child('codex-a-aaaa', 150), child('codex-b-bbbb', 700)]);
  assert.equal(results.filter((r) => r === 'ok').length, 1, results.join(','));
});

test('lock: a holder whose job folder exists but job.json is unreadable is not reclaimed', () => {
  const w = lockWs();
  const holder = createJob(w, { vendor: 'codex', kind: 'ask', promptSummary: 'p', flags: { write: true } });
  fs.writeFileSync(path.join(jobDir(w, holder.id), 'job.json'), '{not json');
  const lock = path.join(w.stateDir, 'writer.lock');
  fs.writeFileSync(lock, holder.id);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  assert.equal(acquireWriter(w, 'codex-me-bbbb', { CREWMATE_SPAWN_GRACE_MS: '100' }).ok, false);
});
