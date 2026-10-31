import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { FIXTURES, runCli } from './helpers.mjs';

const fx = (n) => path.join(FIXTURES, n);

test('codex ready when login status exits 0; not ready with the login hint otherwise', async () => {
  const ok = await runCli(['setup'], { fakes: ['codex'] });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /codex: ready/);
  const no = await runCli(['setup'], { fakes: ['codex'], env: { FAKE_LOGIN_EXIT: '1' } });
  assert.match(no.stdout, /codex: not ready: run `codex login`/);
});

test('gemini ready when the agy probe returns SUCCESS', async () => {
  const r = await runCli(['setup', '--json'], { fakes: ['agy'], env: { FAKE_FIXTURE: fx('agy-plan.ndjson') } });
  assert.equal(r.code, 0, r.stderr);
  const body = JSON.parse(r.stdout);
  assert.equal(body.vendors.gemini.ready, true);
  assert.equal(body.vendors.codex.ready, false);
  assert.equal(body.node.ok, true);
});

test('a hanging agy probe is not ready within 2 s', async () => {
  const t0 = Date.now();
  const r = await runCli(['setup'], { fakes: ['agy'], env: { FAKE_HANG: '1', CREWMATE_PROBE_MS: '300' } });
  assert.ok(Date.now() - t0 < 2000);
  assert.match(r.stdout, /gemini: not ready: run `agy` once to sign in/);
  assert.equal(r.code, 3);
});

test('no vendors → exit 3 with both install lines', async () => {
  const r = await runCli(['setup'], { fakes: [] });
  assert.equal(r.code, 3);
  assert.match(r.stdout, /npm i -g @openai\/codex/);
  assert.match(r.stdout, /antigravity\.google\/cli\/install\.sh/);
});
