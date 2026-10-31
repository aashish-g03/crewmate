// watch / status / result / cancel through the real CLI (T-numbers are spec §4.11 ids).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveWorkspace } from '../plugins/crewmate/lib/workspace.mjs';
import { createJob, readJob, jobDir, writeJob } from '../plugins/crewmate/lib/jobs.mjs';
import { effectiveState, processStartTime } from '../plugins/crewmate/lib/liveness.mjs';
import { spawnRunner } from '../plugins/crewmate/lib/runner.mjs';
import { FIXTURES, fakePath, runCli, tempDir, tempHome, waitFor } from './helpers.mjs';

const FINAL = ['done', 'failed', 'timeout', 'canceled'];
const fx = (n) => path.join(FIXTURES, n);

function setup() {
  const { home } = tempHome();
  const cwd = tempDir();
  const ws = resolveWorkspace(cwd, { CREWMATE_HOME: home });
  const cli = (args, opts = {}) => runCli(args, { cwd, home, ...opts });
  return { home, cwd, ws, cli };
}
const idOf = (r) => r.stdout.trim().split('\n')[0];
async function finalOf(ws, id) {
  return waitFor(() => {
    const j = readJob(ws, id);
    return j && FINAL.includes(effectiveState(j).state) ? { ...j, ...effectiveState(j) } : null;
  }, 10_000);
}
const groupGone = (pid) => { try { process.kill(-pid, 0); return false; } catch { return true; } };

test('(T13) watch on a finished job replays its events and exits 0 at once', async () => {
  const { cli, ws } = setup();
  const id = idOf(await cli(['ask', 'codex', '--detach', 'x'], { env: { FAKE_FIXTURE: fx('codex.ndjson') } }));
  await finalOf(ws, id);
  const t0 = Date.now();
  const w = await cli(['watch', id]);
  assert.equal(w.code, 0, w.stderr);
  assert.ok(Date.now() - t0 < 3000);
  assert.match(w.stdout, /codex #1 .*started/);
  assert.match(w.stdout, /shell/);
  assert.match(w.stdout, /done/);
});

test('(T14) watch on a job whose runner was killed exits 1 within 2 s with runner died', async () => {
  const { cli, ws } = setup();
  const id = idOf(await cli(['ask', 'codex', '--detach', 'x'], { env: { FAKE_HANG: '1' } }));
  const j = await waitFor(() => { const r = readJob(ws, id); return r?.runner && r?.vendorProcess ? r : null; });
  process.kill(j.runner.pid, 'SIGKILL');
  const t0 = Date.now();
  const w = await cli(['watch', id]);
  assert.equal(w.code, 1);
  assert.match(w.stdout, /runner died/);
  assert.ok(Date.now() - t0 < 2500);
  try { process.kill(-j.vendorProcess.pid, 'SIGKILL'); } catch {}
});

test('(T15) watch a b exits only after both end, with the worst state', async () => {
  const { cli, ws } = setup();
  const a = idOf(await cli(['ask', 'codex', '--detach', 'a'], { env: { FAKE_FIXTURE: fx('codex.ndjson') } }));
  const b = idOf(await cli(['ask', 'codex', '--detach', 'b'], { env: { FAKE_FIXTURE: fx('codex.ndjson'), FAKE_EXIT: '2', FAKE_DELAY_MS: '200' } }));
  const w = await cli(['watch', a, b]);
  assert.equal(w.code, 1);
  assert.ok(FINAL.includes(readJob(ws, a).state) && FINAL.includes(readJob(ws, b).state));
  assert.equal((w.stdout.match(/■/g) ?? []).length, 2);
});

test('merging: 20 read_file steps print at most 3 read_file lines', async () => {
  const { cli } = setup();
  const r = await cli(['ask', 'gemini', 'read'], { env: { FAKE_FIXTURE: fx('agy-many-reads.ndjson') } });
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.split('\n').filter((l) => l.includes('read_file'));
  assert.ok(lines.length <= 3, lines.join('\n'));
  assert.ok(lines.some((l) => /×\s?\d+/.test(l)));
});

test('(T7) cancel stops a running job: watch exits 5 and the vendor group is gone', async () => {
  const { cli, ws } = setup();
  const id = idOf(await cli(['ask', 'codex', '--detach', 'x'], { env: { FAKE_FIXTURE: fx('codex.ndjson'), FAKE_HANG_AFTER: '3', CREWMATE_CANCEL_GRACE_MS: '300' } }));
  const j = await waitFor(() => readJob(ws, id)?.vendorProcess);
  const c = await cli(['cancel', id], { env: { CREWMATE_CANCEL_GRACE_MS: '300' } });
  assert.equal(c.code, 0, c.stderr);
  assert.match(c.stdout, /canceled/);
  const w = await cli(['watch', id]);
  assert.equal(w.code, 5);
  assert.ok(groupGone(j.pid));
});

test('cancel never signals a process whose start time does not match', async () => {
  const { cli, ws } = setup();
  const victim = spawn('sleep', ['30']);
  const job = createJob(ws, { vendor: 'codex', kind: 'ask', promptSummary: 'p', flags: {} });
  writeJob(ws, { ...job, state: 'running', runner: { pid: victim.pid, startTime: 'Thu Jan  1 00:00:00 1970' } });
  const c = await cli(['cancel', job.id]);
  assert.equal(c.code, 0);
  assert.ok(processStartTime(victim.pid), 'victim still alive');
  victim.kill('SIGKILL');
});

test('(T8 cleanup) after the runner is killed, cancel kills the left-over vendor group', async () => {
  const { cli, ws } = setup();
  const id = idOf(await cli(['ask', 'codex', '--detach', 'x'], { env: { FAKE_HANG: '1' } }));
  const j = await waitFor(() => { const r = readJob(ws, id); return r?.runner && r?.vendorProcess ? r : null; });
  process.kill(j.runner.pid, 'SIGKILL');
  await waitFor(() => effectiveState(readJob(ws, id)).reason === 'runner died');
  assert.ok(!groupGone(j.vendorProcess.pid), 'vendor survived its runner');
  await cli(['cancel', id]);
  await waitFor(() => groupGone(j.vendorProcess.pid), 3000);
});

test('Review Focus 4: watch started before the runner exists waits and does not report runner died', async () => {
  const { home, cwd, ws } = setup();
  const job = createJob(ws, { vendor: 'codex', kind: 'ask', promptSummary: 'p', flags: { timeoutMs: 10_000 } });
  fs.writeFileSync(path.join(jobDir(ws, job.id), 'prompt.txt'), 'x');
  const watching = runCli(['watch', job.id], { cwd, home });
  await new Promise((r) => setTimeout(r, 600));
  spawnRunner(ws, job.id, { PATH: fakePath(['codex']), HOME: home, CREWMATE_HOME: home, FAKE_FIXTURE: fx('codex.ndjson') });
  const w = await watching;
  assert.equal(w.code, 0, w.stdout + w.stderr);
  assert.match(w.stdout, /started/);
  assert.doesNotMatch(w.stdout, /runner died|never started/);
});

test('ask without --detach exits with the job exit code', async () => {
  const { cli } = setup();
  assert.equal((await cli(['ask', 'codex', 'x'], { env: { FAKE_FIXTURE: fx('codex.ndjson') } })).code, 0);
  assert.equal((await cli(['ask', 'codex', 'x'], { env: { FAKE_FIXTURE: fx('codex.ndjson'), FAKE_EXIT: '2' } })).code, 1);
});

test('status, result and --json shapes; unknown ids exit 2; result on a running job exits 2', async () => {
  const { cli, ws } = setup();
  const id = idOf(await cli(['ask', 'gemini', '--detach', 'x'], { env: { FAKE_FIXTURE: fx('agy-denied-with-answer.ndjson') } }));
  await finalOf(ws, id);
  const s = await cli(['status', '--json']);
  assert.equal(s.code, 0);
  const rows = JSON.parse(s.stdout);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['createdAt', 'endedAt', 'id', 'kind', 'promptSummary', 'reason', 'state', 'vendor', 'write'].sort());
  assert.equal(rows[0].state, 'done');
  const r = await cli(['result', id, '--json']);
  const body = JSON.parse(r.stdout);
  assert.equal(body.answer, 'done');
  assert.deepEqual(body.job.outcome.deniedTools, ['RunCommand']);
  const text = await cli(['result', id]);
  assert.match(text.stdout, /RunCommand/);
  for (const cmd of ['result', 'watch', 'status', 'cancel']) {
    assert.equal((await cli([cmd, 'codex-nope-0000'])).code, 2, cmd);
  }
  const hang = idOf(await cli(['ask', 'codex', '--detach', 'x'], { env: { FAKE_HANG: '1' } }));
  const still = await cli(['result', hang]);
  assert.equal(still.code, 2);
  assert.match(still.stderr, /still running/);
  await cli(['cancel', hang], { env: { CREWMATE_CANCEL_GRACE_MS: '200' } });
});
