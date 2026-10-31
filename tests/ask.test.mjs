// ask / critique through the real CLI with fake vendors (T-numbers are spec §4.11 ids).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveWorkspace } from '../plugins/crewmate/lib/workspace.mjs';
import { listJobs, readJob, jobDir } from '../plugins/crewmate/lib/jobs.mjs';
import { effectiveState } from '../plugins/crewmate/lib/liveness.mjs';
import { FIXTURES, runCli, tempDir, tempHome, waitFor } from './helpers.mjs';

const FINAL = ['done', 'failed', 'timeout', 'canceled'];
const fx = (n) => path.join(FIXTURES, n);

function setup() {
  const { home } = tempHome();
  const cwd = tempDir();
  const ws = resolveWorkspace(cwd, { CREWMATE_HOME: home });
  const cli = (args, opts = {}) => runCli(args, { cwd, home, ...opts });
  return { home, cwd, ws, cli };
}

async function finalOf(ws, id) {
  return waitFor(() => {
    const j = readJob(ws, id);
    return j && FINAL.includes(effectiveState(j).state) ? { ...j, ...effectiveState(j) } : null;
  }, 10_000);
}

const idOf = (r) => r.stdout.trim().split('\n')[0];

test('vendor binary not on PATH → exit 3 with install text, no job created', async () => {
  const { cli, ws } = setup();
  const r = await cli(['ask', 'codex', 'hi'], { fakes: [] });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /npm i -g @openai\/codex/);
  assert.equal(listJobs(ws).length, 0);
});

test('(T11) path-like vendor → exit 2; bad --timeout → exit 2; empty prompt → exit 2', async () => {
  const { cli } = setup();
  assert.equal((await cli(['ask', '../x', 'hi'])).code, 2);
  assert.equal((await cli(['ask', 'codex', '--timeout', '10', 'hi'])).code, 2);
  assert.equal((await cli(['ask', 'codex', '   '])).code, 2);
});

test('a prompt over 100,000 bytes → exit 2, prompt too large, no job folder', async () => {
  const { cli, ws } = setup();
  const r = await cli(['ask', 'codex', '--detach'], { input: 'x'.repeat(100_001) });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /prompt too large/);
  assert.equal(listJobs(ws).length, 0);
});

test('Review Focus 1: prompts from stdin and --prompt-file arrive byte-identical', async () => {
  const { cli, ws, cwd } = setup();
  const prompt = '-x "quotes" $HOME\nsecond line';
  const log = path.join(cwd, 'argv.log');
  const env = { FAKE_FIXTURE: fx('codex.ndjson'), FAKE_ARGV_LOG: log };
  const a = await cli(['ask', 'codex', '--detach'], { input: prompt, env });
  assert.equal(a.code, 0, a.stderr);
  await finalOf(ws, idOf(a));
  const file = path.join(cwd, 'p.txt');
  fs.writeFileSync(file, prompt);
  const b = await cli(['ask', 'codex', '--detach', '--prompt-file', file], { env });
  assert.equal(b.code, 0, b.stderr);
  await finalOf(ws, idOf(b));
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 2);
  for (const argv of calls) assert.equal(argv.at(-1), prompt);
});

test('(T9) a second --write while a writer runs → exit 6; after it ends → 0; --yolo refused too', async () => {
  const { cli, ws } = setup();
  const env = { FAKE_FIXTURE: fx('codex.ndjson'), FAKE_DELAY_MS: '300' };
  const first = await cli(['ask', 'codex', '--write', '--detach', 'one'], { env });
  assert.equal(first.code, 0, first.stderr);
  const firstId = idOf(first);
  const second = await cli(['ask', 'codex', '--write', '--detach', 'two'], { env });
  assert.equal(second.code, 6);
  assert.match(second.stderr, new RegExp(firstId));
  const yolo = await cli(['ask', 'codex', '--yolo', '--detach', 'three'], { env });
  assert.equal(yolo.code, 6);
  await finalOf(ws, firstId);
  const third = await cli(['ask', 'codex', '--write', '--detach', 'four'], { env: { FAKE_FIXTURE: fx('codex.ndjson') } });
  assert.equal(third.code, 0, third.stderr);
  await finalOf(ws, idOf(third));
});

test('(T9) a lock left by a killed runner does not block', async () => {
  const { cli, ws } = setup();
  const first = await cli(['ask', 'codex', '--write', '--detach', 'one'], { env: { FAKE_HANG: '1' } });
  const id = idOf(first);
  const job = await waitFor(() => { const j = readJob(ws, id); return j?.runner && j?.vendorProcess ? j : null; });
  process.kill(job.runner.pid, 'SIGKILL');
  try { process.kill(-job.vendorProcess.pid, 'SIGKILL'); } catch {}
  await finalOf(ws, id);
  const next = await cli(['ask', 'codex', '--write', '--detach', 'two'], { env: { FAKE_FIXTURE: fx('codex.ndjson') } });
  assert.equal(next.code, 0, next.stderr);
  await finalOf(ws, idOf(next));
});

test('Review Focus 5: two simultaneous --write calls → exactly one 0 and one 6', async () => {
  const { cli, ws } = setup();
  const env = { FAKE_FIXTURE: fx('codex.ndjson'), FAKE_DELAY_MS: '300' };
  const rs = await Promise.all([1, 2].map((i) => cli(['ask', 'codex', '--write', '--detach', `x${i}`], { env })));
  assert.deepEqual(rs.map((r) => r.code).sort(), [0, 6]);
  const ok = rs.find((r) => r.code === 0);
  await finalOf(ws, idOf(ok));
  assert.equal(listJobs(ws).length, 1, 'the refused job folder is removed');
});

test('(T10/T16) --resume uses the stored thread id, stays read-only, skips critique jobs; refused while running', async () => {
  const { cli, ws, cwd } = setup();
  const first = await cli(['ask', 'codex', '--detach', 'first'], { env: { FAKE_FIXTURE: fx('codex.ndjson') } });
  const firstId = idOf(first);
  await finalOf(ws, firstId);
  fs.writeFileSync(path.join(cwd, 'a.md'), '# doc');
  const crit = await cli(['critique', 'a.md', '--vendors', 'codex'], { env: { FAKE_FIXTURE: fx('codex-denied.ndjson') } });
  assert.equal(crit.code, 0, crit.stderr);
  await finalOf(ws, idOf(crit));
  const log = path.join(cwd, 'argv.log');
  const env = { FAKE_FIXTURE: fx('codex.ndjson'), FAKE_ARGV_LOG: log };
  const r = await cli(['ask', 'codex', '--detach', '--resume', 'again'], { env });
  assert.equal(r.code, 0, r.stderr);
  await finalOf(ws, idOf(r));
  const r2 = await cli(['ask', 'codex', '--detach', `--resume=${firstId}`, 'again2'], { env });
  assert.equal(r2.code, 0, r2.stderr);
  await finalOf(ws, idOf(r2));
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const argv of calls) {
    assert.equal(argv[1], 'resume');
    assert.ok(argv.includes('01a193d0-87dd-7341-9392-cbf04ee3bb21'));
    assert.ok(argv.includes('sandbox_mode="read-only"'));
  }
  const running = await cli(['ask', 'codex', '--detach', 'slow'], { env: { FAKE_HANG: '1' } });
  const busy = await cli(['ask', 'codex', '--detach', '--resume', 'x'], { env });
  assert.equal(busy.code, 6);
  const j = readJob(ws, idOf(running));
  const vend = await waitFor(() => readJob(ws, j.id)?.vendorProcess);
  process.kill(readJob(ws, j.id).runner.pid, 'SIGKILL');
  try { process.kill(-vend.pid, 'SIGKILL'); } catch {}
});

test('--resume with nothing to resume → exit 2', async () => {
  const { cli } = setup();
  const r = await cli(['ask', 'codex', '--resume', 'x']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /nothing to resume/);
});

test('critique: one job per available vendor; none → 7; no target → 2; --diff outside git → 2', async () => {
  const { cli, cwd, ws } = setup();
  fs.writeFileSync(path.join(cwd, 'a.md'), '# doc');
  const one = await cli(['critique', 'a.md'], { fakes: ['codex'], env: { FAKE_FIXTURE: fx('codex.ndjson') } });
  assert.equal(one.code, 0, one.stderr);
  assert.equal(one.stdout.trim().split('\n').length, 1);
  await finalOf(ws, idOf(one));
  assert.equal((await cli(['critique', 'a.md'], { fakes: [] })).code, 7);
  assert.equal((await cli(['critique'])).code, 2);
  assert.equal((await cli(['critique', 'missing.md'])).code, 2);
  const nd = await cli(['critique', '--diff']);
  assert.equal(nd.code, 2);
  assert.match(nd.stderr, /git repository/);
});

test('critique --diff whose prompt would exceed 100,000 bytes → exit 2; a small diff is inlined', async () => {
  const { cli, cwd, ws } = setup();
  spawnSync('git', ['init', '-q', cwd]);
  spawnSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  fs.writeFileSync(path.join(cwd, 'big.txt'), 'y'.repeat(20));
  spawnSync('git', ['-C', cwd, 'add', 'big.txt']);
  const small = await cli(['critique', '--diff', '--vendors', 'codex'], { env: { FAKE_FIXTURE: fx('codex.ndjson') } });
  assert.equal(small.code, 0, small.stderr);
  const id = idOf(small);
  await finalOf(ws, id);
  const prompt = fs.readFileSync(path.join(jobDir(ws, id), 'prompt.txt'), 'utf8');
  assert.match(prompt, /big\.txt/);
  assert.match(prompt, /crucial tests only|failure mode/i);
  fs.writeFileSync(path.join(cwd, 'big.txt'), 'line\n'.repeat(30_000));
  const big = await cli(['critique', '--diff', '--vendors', 'codex']);
  assert.equal(big.code, 2);
  assert.match(big.stderr, /too large/);
});
