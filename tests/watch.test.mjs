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

test('CP2-3: cancel on a queued job with no runner yet marks it canceled, and a late runner does not revive it', async () => {
  const { cli, ws, home } = setup();
  const job = createJob(ws, { vendor: 'codex', kind: 'ask', promptSummary: 'p', flags: { timeoutMs: 5000 } });
  fs.writeFileSync(path.join(jobDir(ws, job.id), 'prompt.txt'), 'x');
  const c = await cli(['cancel', job.id], { env: { CREWMATE_SPAWN_GRACE_MS: '300' } });
  assert.equal(c.code, 0, c.stderr);
  assert.equal(readJob(ws, job.id).state, 'canceled');
  spawnRunner(ws, job.id, { PATH: fakePath(['codex']), HOME: home, CREWMATE_HOME: home, FAKE_FIXTURE: fx('codex.ndjson') });
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(readJob(ws, job.id).state, 'canceled');
});

// ---- Checkpoint 3 review + dogfood critique findings ----
import { appendEvent, readEvents } from '../plugins/crewmate/lib/events.mjs';

test('CP3-1a: watch on a job canceled before start exits 5 instead of hanging', async () => {
  const { cli, ws } = setup();
  const job = createJob(ws, { vendor: 'codex', kind: 'ask', promptSummary: 'p', flags: { timeoutMs: 5000 } });
  await cli(['cancel', job.id], { env: { CREWMATE_SPAWN_GRACE_MS: '200' } });
  const t0 = Date.now();
  const w = await cli(['watch', job.id]);
  assert.equal(w.code, 5);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(readEvents(jobDir(ws, job.id)).at(-1).type, 'end', 'cancel wrote an end event');
});

test('CP3-1b: watch --since past the end line exits at once with the final state', async () => {
  const { cli, ws } = setup();
  const id = idOf(await cli(['ask', 'codex', '--detach', 'x'], { env: { FAKE_FIXTURE: fx('codex.ndjson') } }));
  await finalOf(ws, id);
  const last = readEvents(jobDir(ws, id)).at(-1).n;
  const t0 = Date.now();
  const w = await cli(['watch', id, `--since=${last}`]);
  assert.equal(w.code, 0);
  assert.ok(Date.now() - t0 < 2000);
  assert.match(w.stdout, /■ done/);
});

test('CP3-1c: watch on a job saved final whose runner died before writing end exits', async () => {
  const { cli, ws } = setup();
  const job = createJob(ws, { vendor: 'codex', kind: 'ask', promptSummary: 'p', flags: {} });
  writeJob(ws, { ...job, state: 'done', runner: { pid: 999999, startTime: 'x' }, endedAt: new Date().toISOString() });
  appendEvent(jobDir(ws, job.id), { n: 1, type: 'started', vendor: 'codex', model: null });
  const w = await cli(['watch', job.id]);
  assert.equal(w.code, 0);
  assert.match(w.stdout, /■ done/);
});

test('CP3-1d: watch on a pruned job folder exits 1 instead of crashing', async () => {
  const { cli, ws } = setup();
  const job = createJob(ws, { vendor: 'codex', kind: 'ask', promptSummary: 'p', flags: { timeoutMs: 5000 } });
  const watching = cli(['watch', job.id]);
  await new Promise((r) => setTimeout(r, 400));
  fs.rmSync(jobDir(ws, job.id), { recursive: true, force: true });
  const w = await watching;
  assert.equal(w.code, 1);
  assert.match(w.stdout + w.stderr, /removed/);
});

test('CP3-2: --resume=<id> of another vendor\'s job → exit 2', async () => {
  const { cli, ws } = setup();
  const g = idOf(await cli(['ask', 'gemini', '--detach', 'x'], { env: { FAKE_FIXTURE: fx('agy-denied-with-answer.ndjson') } }));
  await finalOf(ws, g);
  const r = await cli(['ask', 'codex', `--resume=${g}`, 'again']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /gemini job/);
});

test('CP3-3: a runner that starts after the spawn grace does not run the job', async () => {
  const { ws, home } = setup();
  const job = createJob(ws, { vendor: 'codex', kind: 'ask', promptSummary: 'p', flags: { timeoutMs: 5000 } });
  fs.writeFileSync(path.join(jobDir(ws, job.id), 'prompt.txt'), 'x');
  writeJob(ws, { ...job, createdAt: new Date(Date.now() - 60_000).toISOString() });
  const log = path.join(tempDir(), 'argv.log');
  spawnRunner(ws, job.id, { PATH: fakePath(['codex']), HOME: home, CREWMATE_HOME: home, FAKE_FIXTURE: fx('codex.ndjson'), FAKE_ARGV_LOG: log });
  await waitFor(() => readJob(ws, job.id).state === 'failed', 5000);
  assert.equal(readJob(ws, job.id).reason, 'runner never started');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fs.existsSync(log), false);
});

test('CP3-4: error notes are never throttled away', async () => {
  const { cli } = setup();
  const r = await cli(['ask', 'codex', 'x'], { env: { FAKE_FIXTURE: fx('codex-reconnect.ndjson') } });
  assert.match(r.stdout, /error: Reconnecting/);
});

test('CP3-5/6: critique --diff with a positional ref → 2; missing --prompt-file → 2 with a short message', async () => {
  const { cli } = setup();
  const d = await cli(['critique', '--diff', 'main']);
  assert.equal(d.code, 2);
  assert.match(d.stderr, /--diff=<ref>/);
  const p = await cli(['ask', 'codex', '--prompt-file', 'nope.txt']);
  assert.equal(p.code, 2);
  assert.doesNotMatch(p.stderr, /at Module/);
});

test('CP3-7: a closed stdout does not crash crewmate', async () => {
  const { home, cwd } = setup();
  const r = spawnSyncShell(`node "${BIN_PATH}" ask codex x | head -1`, { cwd, env: { PATH: fakePath(['codex']), HOME: home, CREWMATE_HOME: home, FAKE_FIXTURE: fx('codex.ndjson'), FAKE_DELAY_MS: '100' } });
  assert.doesNotMatch(r.stderr, /EPIPE|Error/);
});

test('CP3-8: cancel SIGKILLs a leftover vendor group that ignores SIGTERM', async () => {
  const { cli, ws } = setup();
  const pidFile = path.join(tempDir(), 'gc.pid');
  const id = idOf(await cli(['ask', 'codex', '--detach', 'x'], { env: { FAKE_HANG: '1', FAKE_GRANDCHILD_PID_FILE: pidFile } }));
  const j = await waitFor(() => { const r = readJob(ws, id); return r?.runner && r?.vendorProcess ? r : null; });
  await waitFor(() => fs.existsSync(pidFile));
  process.kill(j.runner.pid, 'SIGKILL');
  await cli(['cancel', id], { env: { CREWMATE_CANCEL_GRACE_MS: '300' } });
  const gc = Number(fs.readFileSync(pidFile, 'utf8'));
  await waitFor(() => processStartTime(gc) === null, 3000);
});

test('dogfood: the vendor runs in the caller\'s folder, not the repo root', async () => {
  const { cli, cwd, ws } = setup();
  spawnSyncShell(`git init -q "${cwd}" && mkdir -p "${cwd}/sub"`);
  const log = path.join(tempDir(), 'pwd.txt');
  const id = idOf(await cli(['ask', 'codex', '--detach', 'x'], { cwd: path.join(cwd, 'sub'), env: { FAKE_FIXTURE: fx('codex.ndjson'), FAKE_PWD_FILE: log } }));
  await finalOf(ws, id);
  assert.equal(fs.readFileSync(log, 'utf8').trim(), fs.realpathSync(path.join(cwd, 'sub')));
});

test('dogfood: ask --json in the foreground prints one JSON object; watch --json prints raw events', async () => {
  const { cli } = setup();
  const r = await cli(['ask', 'codex', '--json', 'x'], { env: { FAKE_FIXTURE: fx('codex.ndjson') } });
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const body = JSON.parse(lines[0]);
  assert.equal(body.state, 'done');
  assert.equal(body.answer, 'done');
  const w = await cli(['watch', body.jobId, '--json']);
  assert.equal(w.code, 0);
  for (const l of w.stdout.trim().split('\n')) assert.ok(JSON.parse(l).type);
});

import { spawnSync as _spawnSync } from 'node:child_process';
import { BIN as BIN_PATH } from './helpers.mjs';
function spawnSyncShell(cmd, opts = {}) {
  return _spawnSync('sh', ['-c', cmd], { encoding: 'utf8', ...opts });
}

test('watch --brief (for Monitor): finished many-reads job prints only the start and end lines', async () => {
  const { cli, ws } = setup();
  const id = idOf(await cli(['ask', 'gemini', '--detach', 'x'], { env: { FAKE_FIXTURE: fx('agy-many-reads.ndjson') } }));
  await finalOf(ws, id);
  const w = await cli(['watch', id, '--brief']);
  assert.equal(w.code, 0);
  const lines = w.stdout.trim().split('\n');
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[0], /started/);
  assert.match(lines[1], /■ done/);
});

test('watch --brief: a summary line per interval while running, errors at once', async () => {
  const { cli } = setup();
  const r = await cli(['ask', 'gemini', '--brief', 'x'], {
    env: { FAKE_FIXTURE: fx('agy-many-reads.ndjson'), FAKE_DELAY_MS: '40', CREWMATE_BRIEF_EVERY_MS: '300' },
  });
  assert.equal(r.code, 0, r.stdout);
  const lines = r.stdout.trim().split('\n');
  assert.ok(lines.some((l) => /\d+ tool steps/.test(l)), lines.join('\n'));
  assert.ok(lines.length < 12, `${lines.length} lines`);
  const e = await cli(['ask', 'gemini', '--brief', 'x'], { env: { FAKE_FIXTURE: fx('agy-denied-with-answer.ndjson') } });
  assert.match(e.stdout, /✗ run_command/);
});
