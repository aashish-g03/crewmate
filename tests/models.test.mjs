// `crewmate models` and --model/--effort validation, driven by recorded real catalogs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveWorkspace } from '../plugins/crewmate/lib/workspace.mjs';
import { listJobs } from '../plugins/crewmate/lib/jobs.mjs';
import { runCli, tempDir, tempHome, FIXTURES } from './helpers.mjs';

function setup({ codexConfig } = {}) {
  const { home } = tempHome();
  if (codexConfig) {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), codexConfig);
  }
  const cwd = tempDir();
  return { home, cwd, ws: resolveWorkspace(cwd, { CREWMATE_HOME: home }), cli: (a, o = {}) => runCli(a, { cwd, home, ...o }) };
}

test('models --json: codex catalog (hidden models excluded, efforts per model) and the configured default', async () => {
  const { cli } = setup({ codexConfig: 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n' });
  const r = await cli(['models', 'codex', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const [c] = JSON.parse(r.stdout).vendors;
  assert.equal(c.vendor, 'codex');
  assert.equal(c.models.length, 8);
  assert.ok(!c.models.some((m) => m.id === 'gpt-reserve'), 'hidden model listed');
  const luna = c.models.find((m) => m.id === 'gpt-6-luna');
  assert.deepEqual(luna.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(luna.defaultEffort, 'medium');
  assert.deepEqual(c.configured, { model: 'gpt-6.1-sol', effort: 'high' });
});

test('models --json: agy list parsed, the "Fetching…" line ignored', async () => {
  const { cli } = setup();
  const r = await cli(['models', 'gemini', '--json']);
  const [g] = JSON.parse(r.stdout).vendors;
  assert.deepEqual(g.models.map((m) => m.id), fs.readFileSync(path.join(FIXTURES, 'agy-models.txt'), 'utf8').split('\n').filter((l) => l.includes('\t')).map((l) => l.split('\t')[0]));
  assert.equal(g.models[0].name, 'Gemini 3.8 Flash (High)');
  assert.deepEqual(g.models[0].efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('models (text) shows both vendors; a vendor whose list fails says so instead of crashing', async () => {
  const { cli } = setup();
  const r = await cli(['models'], { env: { FAKE_MODELS_FAIL: '1' } });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /codex: model list unavailable/);
  assert.match(r.stdout, /gemini: model list unavailable/);
  const missing = await cli(['models'], { fakes: [] });
  assert.match(missing.stdout, /codex: not installed/);
});

test('ask --model typo → exit 2 naming the choices, no job created', async () => {
  const { cli, ws } = setup();
  const r = await cli(['ask', 'codex', '--model', 'gpt-6.1-sool', '--detach', 'hi']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown codex model "gpt-6.1-sool".*gpt-6.1-sol/s);
  assert.equal(listJobs(ws).length, 0);
  const g = await cli(['ask', 'gemini', '--model', 'gemini-9', '--detach', 'hi']);
  assert.equal(g.code, 2);
  assert.match(g.stderr, /gemini-3.8-flash-high/);
});

test('ask --effort the chosen (or configured) model does not support → exit 2', async () => {
  const { cli } = setup({ codexConfig: 'model = "gpt-6-luna"\n' });
  const r = await cli(['ask', 'codex', '--model', 'gpt-6-luna', '--effort', 'ultra', '--detach', 'hi']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /gpt-6-luna.*low, medium, high, xhigh, max/s);
  const cfg = await cli(['ask', 'codex', '--effort', 'ultra', '--detach', 'hi']);
  assert.equal(cfg.code, 2, 'configured model gpt-6-luna has no ultra');
  const g = await cli(['ask', 'gemini', '--effort', 'ultra', '--detach', 'hi']);
  assert.equal(g.code, 2);
});

test('valid --model/--effort start a job; an unreadable catalog never blocks a job', async () => {
  const { cli, ws } = setup();
  const ok = await cli(['ask', 'codex', '--model', 'gpt-6-sol', '--effort', 'ultra', '--detach', 'hi'], { env: { FAKE_HANG: '1' } });
  assert.equal(ok.code, 0, ok.stderr);
  const blind = await cli(['ask', 'gemini', '--model', 'brand-new-model', '--detach', 'hi'], { env: { FAKE_MODELS_FAIL: '1', FAKE_HANG: '1' } });
  assert.equal(blind.code, 0, blind.stderr);
  for (const j of listJobs(ws)) await cli(['cancel', j.id], { env: { CREWMATE_CANCEL_GRACE_MS: '200' } });
});
