import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { assertName, parseDuration, UsageError } from '../plugins/crewmate/lib/names.mjs';
import { resolveWorkspace } from '../plugins/crewmate/lib/workspace.mjs';
import { newJobId, createJob, readJob, jobDir, listJobs, pruneJobs, writeJob } from '../plugins/crewmate/lib/jobs.mjs';
import { tempDir, tempHome } from './helpers.mjs';

test('assertName rejects unsafe names and unknown vendors', () => {
  for (const bad of ['../x', 'A', '', 'a'.repeat(65)]) {
    assert.throws(() => assertName('job', bad), UsageError, bad);
  }
  assert.equal(assertName('job', 'gemini-k2x-ab12'), 'gemini-k2x-ab12');
  assert.equal(assertName('vendor', 'codex'), 'codex');
  assert.throws(() => assertName('vendor', 'kimi'), UsageError);
});

test('parseDuration follows the grammar', () => {
  assert.equal(parseDuration('90s'), 90000);
  assert.equal(parseDuration('10m'), 600000);
  assert.equal(parseDuration('250ms'), 250);
  assert.equal(parseDuration('1h'), 3600000);
  assert.throws(() => parseDuration('10'), UsageError);
  assert.throws(() => parseDuration('1d'), UsageError);
});

test('resolveWorkspace: spaces and non-ASCII give a valid slug under CREWMATE_HOME', () => {
  const { home, cleanup } = tempHome();
  const parent = tempDir();
  const dir = path.join(parent, 'my repo ü');
  fs.mkdirSync(dir);
  const ws = resolveWorkspace(dir, { CREWMATE_HOME: home });
  const real = fs.realpathSync(dir);
  const hash = crypto.createHash('sha256').update(real).digest('hex').slice(0, 16);
  assert.equal(ws.root, real);
  assert.equal(ws.slug, 'my-repo--');
  assert.equal(ws.stateDir, path.join(home, '.crewmate', 'workspaces', `my-repo---${hash}`));
  cleanup();
});

test('resolveWorkspace: a git subfolder resolves to the git root', () => {
  const repo = tempDir();
  spawnSync('git', ['init', '-q', repo]);
  const sub = path.join(repo, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(resolveWorkspace(sub, { CREWMATE_HOME: repo }).root, fs.realpathSync(repo));
});

function ws() {
  const { home } = tempHome();
  const dir = tempDir();
  return resolveWorkspace(dir, { CREWMATE_HOME: home });
}

test('newJobId satisfies the name rule', () => {
  const id = newJobId('gemini');
  assert.equal(assertName('job', id), id);
  assert.match(id, /^gemini-[a-z0-9]+-[a-z0-9]{4}$/);
});

test('createJob then readJob round-trips; a stale tmp file never shadows job.json', () => {
  const w = ws();
  const job = createJob(w, { vendor: 'codex', kind: 'ask', promptSummary: 'hi', flags: { write: false } });
  assert.equal(job.state, 'queued');
  fs.writeFileSync(path.join(jobDir(w, job.id), 'job.json.tmp'), '{"broken":');
  const back = readJob(w, job.id);
  assert.equal(back.id, job.id);
  assert.equal(back.vendor, 'codex');
  assert.equal(readJob(w, 'codex-nope-0000'), null);
  writeJob(w, { ...back, state: 'running' });
  assert.equal(readJob(w, job.id).state, 'running');
});

function seed(w, n, state, t0) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const job = createJob(w, { vendor: 'codex', kind: 'ask', promptSummary: 'x', flags: {} });
    writeJob(w, { ...job, state, createdAt: new Date(t0 + i * 1000).toISOString() });
    ids.push(job.id);
  }
  return ids;
}
const isFinal = (j) => ['done', 'failed', 'timeout', 'canceled'].includes(j.state);

test('pruneJobs removes only finished jobs beyond the newest 50', () => {
  const w = ws();
  const finished = seed(w, 52, 'done', 1_000_000);
  const running = seed(w, 3, 'running', 0);
  const removed = pruneJobs(w, isFinal, 50);
  assert.deepEqual(new Set(removed), new Set(finished.slice(0, 2)));
  for (const id of running) assert.ok(readJob(w, id), `running ${id} kept`);
  assert.equal(listJobs(w).length, 53);
});

test('pruneJobs keeps the job named in writer.lock', () => {
  const w = ws();
  const finished = seed(w, 52, 'done', 1_000_000);
  fs.writeFileSync(path.join(w.stateDir, 'writer.lock'), finished[0]);
  const removed = pruneJobs(w, isFinal, 50);
  assert.ok(!removed.includes(finished[0]));
  assert.ok(readJob(w, finished[0]));
  assert.deepEqual(removed, [finished[1]]);
});

test('listJobs is newest first', () => {
  const w = ws();
  const ids = seed(w, 3, 'done', 5_000);
  assert.deepEqual(listJobs(w).map((j) => j.id), [...ids].reverse());
});
