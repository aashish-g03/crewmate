import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getAdapter, findOnPath, INSTALL_TEXT } from '../plugins/crewmate/lib/vendors/index.mjs';
import { FIXTURES, tempDir } from './helpers.mjs';

function replay(vendor, fixture) {
  const p = getAdapter(vendor).createParser();
  const events = [];
  for (const line of fs.readFileSync(path.join(FIXTURES, fixture), 'utf8').split('\n')) {
    if (line) events.push(...p.feed(line));
  }
  return { events, outcome: p.finish() };
}

const job = (flags = {}) => ({ id: 'x-1-aaaa', vendor: 'codex', flags: { timeoutMs: 600000, ...flags } });

test('codex.ndjson: one shell start/done pair, thread id, usage', () => {
  const { events, outcome } = replay('codex', 'codex.ndjson');
  const tools = events.filter((e) => e.type === 'tool');
  assert.deepEqual(tools.map((e) => [e.name, e.phase, e.target]), [
    ['shell', 'start', "/bin/zsh -lc 'ls -la'"],
    ['shell', 'done', "/bin/zsh -lc 'ls -la'"],
  ]);
  assert.equal(outcome.conversationId, '01a193d0-87dd-7341-9392-cbf04ee3bb21');
  assert.equal(outcome.usage.input, 29395);
  assert.equal(outcome.answer, null);
  assert.ok(events.some((e) => e.type === 'usage'));
});

test('codex-denied.ndjson: no tool events, no tool errors, exactly two notes (spec §4.4 limit)', () => {
  const { events, outcome } = replay('codex', 'codex-denied.ndjson');
  assert.equal(events.filter((e) => e.type === 'tool').length, 0);
  assert.deepEqual(outcome.toolErrors, []);
  assert.equal(events.filter((e) => e.type === 'note').length, 2);
});

test('codex-tool-error.ndjson: non-zero command is a tool error', () => {
  const { events, outcome } = replay('codex', 'codex-tool-error.ndjson');
  assert.ok(events.some((e) => e.type === 'tool' && e.phase === 'error'));
  assert.equal(outcome.toolErrors.length, 1);
});

test('agy2.ndjson: tool error for run_command, RunCommand denied, empty answer, request-review', () => {
  const { events, outcome } = replay('gemini', 'agy2.ndjson');
  assert.ok(events.some((e) => e.type === 'tool' && e.name === 'run_command' && e.phase === 'error'));
  assert.deepEqual(outcome.deniedTools, ['RunCommand']);
  assert.equal(outcome.answer, '');
  assert.equal(outcome.permissionMode, 'request-review');
  assert.ok(events.some((e) => e.type === 'usage'));
});

test('agy-plan.ndjson: read_file and write_file start/done, no vendor error, no empty note', () => {
  const { events, outcome } = replay('gemini', 'agy-plan.ndjson');
  const pairs = events.filter((e) => e.type === 'tool').map((e) => `${e.name}:${e.phase}`);
  for (const want of ['read_file:start', 'read_file:done', 'write_file:start', 'write_file:done']) {
    assert.ok(pairs.includes(want), want);
  }
  assert.equal(outcome.vendorError, null);
  assert.ok(events.filter((e) => e.type === 'note').every((e) => e.text.trim() !== ''));
  assert.equal(pairs.filter((p) => p === 'write_file:start').length, 1, 'repeated ACTIVE emits once');
});

test('no events for codex turn.started or any agy user_input step', () => {
  const c = getAdapter('codex').createParser();
  assert.deepEqual(c.feed('{"type":"turn.started"}'), []);
  for (const f of ['agy2.ndjson', 'agy-plan.ndjson', 'agy-accept-edits.ndjson']) {
    const p = getAdapter('gemini').createParser();
    const line = fs.readFileSync(path.join(FIXTURES, f), 'utf8').split('\n').find((l) => l.includes('"user_input"'));
    assert.deepEqual(p.feed(line), [], f);
  }
});

test('isModelEvent excludes init, user_input, thread.started and turn.started', () => {
  const g = getAdapter('gemini').createParser();
  const lines = fs.readFileSync(path.join(FIXTURES, 'agy2.ndjson'), 'utf8').split('\n');
  assert.equal(g.isModelEvent(lines[0]), false);
  assert.equal(g.isModelEvent(lines[1]), false);
  assert.equal(g.isModelEvent(lines[2]), true);
  const c = getAdapter('codex').createParser();
  assert.equal(c.isModelEvent('{"type":"thread.started","thread_id":"x"}'), false);
  assert.equal(c.isModelEvent('{"type":"turn.started"}'), false);
  assert.equal(c.isModelEvent('{"type":"item.completed","item":{"type":"agent_message","text":"x"}}'), true);
});

test('non-JSON and unknown lines become notes; fixture_note lines are ignored', () => {
  for (const v of ['codex', 'gemini']) {
    const p = getAdapter(v).createParser();
    assert.deepEqual(p.feed('panic: not json'), [{ type: 'note', text: 'panic: not json' }]);
    assert.equal(p.feed('{"type":"mystery","event":"mystery"}')[0].type, 'note');
    assert.deepEqual(p.feed('{"fixture_note":"synthetic"}'), []);
  }
});

const PROMPT = '-rf "quoted"\nline2';

test('buildArgs: prompt position (Review Focus 1)', () => {
  const c = getAdapter('codex').buildArgs(job(), PROMPT, '/r.md');
  assert.equal(c.at(-1), PROMPT);
  assert.equal(c.at(-2), '--');
  const g = getAdapter('gemini').buildArgs({ ...job(), vendor: 'gemini' }, PROMPT, '/r.md');
  assert.equal(g[0], '-p');
  assert.equal(g[1], PROMPT);
});

test('buildArgs: codex resume keeps read-only via -c and never uses -s', () => {
  const a = getAdapter('codex').buildArgs(job({ resumeConversationId: 'tid-1' }), 'p', '/r.md');
  assert.equal(a[1], 'resume');
  assert.ok(a.includes('tid-1'));
  assert.ok(a.includes('sandbox_mode="read-only"'));
  assert.ok(!a.includes('-s'));
  assert.ok(a.includes('--skip-git-repo-check'));
  const w = getAdapter('codex').buildArgs(job({ write: true }), 'p', '/r.md');
  assert.ok(w.includes('sandbox_mode="workspace-write"'));
  const y = getAdapter('codex').buildArgs(job({ yolo: true, model: 'm1', effort: 'high' }), 'p', '/r.md');
  assert.ok(y.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!y.some((x) => x.startsWith('sandbox_mode')));
  assert.deepEqual(y.slice(y.indexOf('-m'), y.indexOf('-m') + 2), ['-m', 'm1']);
  assert.ok(y.includes('model_reasoning_effort="high"'));
});

test('buildArgs: gemini modes, print-timeout, model, effort, resume', () => {
  const g = (flags) => getAdapter('gemini').buildArgs({ ...job(flags), vendor: 'gemini' }, 'p', '/r.md');
  const w = g({ write: true });
  assert.deepEqual(w.slice(w.indexOf('--mode'), w.indexOf('--mode') + 2), ['--mode', 'accept-edits']);
  const d = g({});
  assert.ok(!d.includes('--mode'), 'read-only: no --mode (headless request-review denies writes)');
  const y = g({ yolo: true });
  assert.ok(y.includes('--dangerously-skip-permissions'));
  assert.ok(!y.includes('--mode'));
  assert.deepEqual(d.slice(d.indexOf('--print-timeout'), d.indexOf('--print-timeout') + 2), ['--print-timeout', '630s']);
  const r = g({ resumeConversationId: 'c-9', model: 'gemini-3.8-flash-low', effort: 'low' });
  assert.ok(r.join(' ').includes('--conversation c-9'));
  assert.ok(r.join(' ').includes('--model gemini-3.8-flash-low'));
  assert.ok(r.join(' ').includes('--effort low'));
});

test('expectedPermissionMode is request-review unless yolo', () => {
  const a = getAdapter('gemini');
  assert.equal(a.expectedPermissionMode(job()), 'request-review');
  assert.equal(a.expectedPermissionMode(job({ write: true })), 'request-review');
  assert.equal(a.expectedPermissionMode(job({ yolo: true })), null);
  assert.equal(getAdapter('codex').expectedPermissionMode(job()), null);
});

test('findOnPath finds executables only; INSTALL_TEXT covers both vendors', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'agy'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'codex'), 'not executable', { mode: 0o644 });
  assert.equal(findOnPath('agy', { PATH: dir }), path.join(dir, 'agy'));
  assert.equal(findOnPath('codex', { PATH: dir }), null);
  assert.match(INSTALL_TEXT.codex, /npm i -g @openai\/codex/);
  assert.match(INSTALL_TEXT.gemini, /antigravity/);
});

import { spawnSync } from 'node:child_process';
import { fakePath } from './helpers.mjs';

test('fake codex replays its fixture, logs argv and writes the -o answer', () => {
  const dir = tempDir();
  const log = path.join(dir, 'argv.log');
  const out = path.join(dir, 'result.md');
  const r = spawnSync('codex', ['exec', '--json', '-o', out, '--', 'hi'], {
    env: { PATH: fakePath(['codex']), FAKE_FIXTURE: path.join(FIXTURES, 'codex.ndjson'), FAKE_ARGV_LOG: log },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim().split('\n').length, 7);
  assert.equal(fs.readFileSync(out, 'utf8'), 'done');
  assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8')), ['exec', '--json', '-o', out, '--', 'hi']);
});

test('CP2-10: other codex item types (file_change, mcp_tool_call) become tool events', () => {
  const p = getAdapter('codex').createParser();
  const ev = p.feed('{"type":"item.completed","item":{"id":"i","type":"file_change","changes":[{"path":"a.js"}],"status":"completed"}}');
  assert.equal(ev[0].type, 'tool');
  assert.equal(ev[0].name, 'file_change');
  assert.deepEqual(p.feed('{"type":"item.completed","item":{"id":"r","type":"reasoning","text":"…"}}'), []);
});

test('gemini read-only runs pass no --mode (plan mode turns questions into plans); write uses accept-edits', () => {
  const g = (flags) => getAdapter('gemini').buildArgs({ id: 'x', vendor: 'gemini', flags: { timeoutMs: 600000, ...flags } }, 'p', '/r.md');
  assert.ok(!g({}).includes('--mode'));
  assert.ok(g({ write: true }).join(' ').includes('--mode accept-edits'));
});
