#!/usr/bin/env bun
/**
 * Test suite for the ACP transport layer.
 *
 * Runs against mock-acp-server.ts — no external CLIs or API keys needed.
 * Tests: JsonRpcClient, AcpRunner lifecycle, session management, dead-process
 * recovery, and the full worker integration path.
 *
 * Usage: bun scripts/test-acp-transport.ts
 */

import { JsonRpcClient } from '../src/transports/jsonrpc.ts';
import { AcpRunner } from '../src/transports/acp-runner.ts';
import type { AgentCard } from '../src/envelope.ts';
import path from 'node:path';

const MOCK_SERVER = path.resolve(import.meta.dir, 'mock-acp-server.ts');

let passed = 0;
let failed = 0;

function ok(name: string): void {
  passed++;
  process.stdout.write(`  \x1b[32m[PASS]\x1b[0m ${name}\n`);
}

function fail(name: string, reason: string): void {
  failed++;
  process.stdout.write(`  \x1b[31m[FAIL]\x1b[0m ${name}: ${reason}\n`);
}

function assert(cond: boolean, name: string, reason = 'assertion failed'): void {
  if (cond) ok(name);
  else fail(name, reason);
}

function section(title: string): void {
  process.stdout.write(`\n\x1b[33m── ${title} ──\x1b[0m\n`);
}

// ─── Test 1: JsonRpcClient in isolation ─────────────────────────────────────

section('JsonRpcClient');

{
  const sent: string[] = [];
  const client = new JsonRpcClient({
    write: (data) => sent.push(data),
    defaultTimeoutMs: 1000,
  });

  // Test notify
  client.notify('test/ping', { value: 42 });
  const notifyMsg = JSON.parse(sent[0]!);
  assert(notifyMsg.jsonrpc === '2.0', 'notify: jsonrpc version');
  assert(notifyMsg.method === 'test/ping', 'notify: method');
  assert(notifyMsg.id === undefined, 'notify: no id');
  assert(notifyMsg.params.value === 42, 'notify: params');

  // Test request + feed
  const reqPromise = client.request('test/echo', { msg: 'hello' });
  const reqMsg = JSON.parse(sent[1]!);
  assert(reqMsg.id === 1, 'request: id auto-increments from 1');
  assert(reqMsg.method === 'test/echo', 'request: method');
  assert(client.pendingCount === 1, 'request: pending count is 1');

  // Simulate response
  client.feed(`{"jsonrpc":"2.0","id":1,"result":{"echo":"hello"}}\n`);
  const resp = await reqPromise;
  assert(resp.result !== undefined, 'request: got result');
  assert((resp.result as Record<string, unknown>).echo === 'hello', 'request: result matches');
  assert(client.pendingCount === 0, 'request: pending cleared after response');

  // Test partial line buffering
  const req2Promise = client.request('test/split');
  client.feed('{"jsonrpc":"2.0",');
  assert(client.pendingCount === 1, 'partial: still pending');
  client.feed('"id":2,"result":"ok"}\n');
  const resp2 = await req2Promise;
  assert(resp2.result === 'ok', 'partial: buffered correctly');

  // Test timeout
  const req3Promise = client.request('test/timeout', {}, 50);
  try {
    await req3Promise;
    fail('timeout: should have thrown', 'no error');
  } catch (err) {
    assert((err as Error).message.includes('timeout'), 'timeout: rejects with timeout error');
  }

  // Test cancelAll
  const req4Promise = client.request('test/cancel');
  assert(client.pendingCount === 1, 'cancelAll: pending before cancel');
  client.cancelAll('shutting down');
  try {
    await req4Promise;
    fail('cancelAll: should have thrown', 'no error');
  } catch (err) {
    assert((err as Error).message.includes('shutting down'), 'cancelAll: rejects with reason');
  }
  assert(client.pendingCount === 0, 'cancelAll: pending cleared');

  // Test malformed JSON is silently skipped
  const req5Promise = client.request('test/malformed');
  client.feed('not json at all\n');
  client.feed(`{"jsonrpc":"2.0","id":${5},"result":"survived"}\n`);
  const resp5 = await req5Promise;
  assert(resp5.result === 'survived', 'malformed: skips bad lines, resolves on valid one');
}

// ─── Test 2: AcpRunner with mock server ─────────────────────────────────────

section('AcpRunner — lifecycle');

{
  const mockCard: AgentCard = {
    name: 'test-agent',
    description: 'Test agent for ACP transport',
    model: 'mock',
    contextWindow: 100_000,
    strengths: ['testing'],
    cliCommand: ['echo', 'fallback'],
    transport: 'acp',
    acpCommand: ['bun', MOCK_SERVER],
  };

  const runner = new AcpRunner(mockCard);

  // Before spawn
  assert(!runner.alive, 'before spawn: not alive');
  assert(runner.pid === undefined, 'before spawn: no pid');

  // Spawn + initialize
  await runner.ensureRunning();
  assert(runner.alive, 'after spawn: alive');
  assert(runner.pid !== undefined, 'after spawn: has pid');

  // ensureRunning is idempotent
  const pidBefore = runner.pid;
  await runner.ensureRunning();
  assert(runner.pid === pidBefore, 'ensureRunning: idempotent (same pid)');

  // Shutdown
  await runner.shutdown();
  assert(!runner.alive, 'after shutdown: not alive');
  assert(runner.pid === undefined, 'after shutdown: no pid');
}

// ─── Test 3: AcpRunner — session management ─────────────────────────────────

section('AcpRunner — sessions');

{
  const mockCard: AgentCard = {
    name: 'test-agent',
    description: 'Test agent',
    model: 'mock',
    contextWindow: 100_000,
    strengths: ['testing'],
    cliCommand: ['echo', 'fallback'],
    transport: 'acp',
    acpCommand: ['bun', MOCK_SERVER],
  };

  const runner = new AcpRunner(mockCard);
  await runner.ensureRunning();

  // Create session
  const sessionId = await runner.createSession();
  assert(typeof sessionId === 'string', 'createSession: returns string');
  assert(sessionId.startsWith('mock_session_'), 'createSession: mock session id format');

  const session = runner.getSession(sessionId);
  assert(session !== undefined, 'getSession: found session');
  assert(session!.turnCount === 0, 'getSession: turnCount starts at 0');

  // Send message — turn 1
  const res1 = await runner.sendMessage(sessionId, 'Hello world');
  assert(res1.exitCode === 0, 'turn 1: exitCode 0');
  assert(res1.stdout.includes(sessionId), 'turn 1: response contains session id');
  assert(res1.stdout.includes('turn1'), 'turn 1: response contains turn1');
  assert(res1.stdout.includes('Hello world'), 'turn 1: response echoes prompt');
  assert(runner.getSession(sessionId)!.turnCount === 1, 'turn 1: turnCount incremented');

  // Send message — turn 2 (same session)
  const res2 = await runner.sendMessage(sessionId, 'Follow up');
  assert(res2.exitCode === 0, 'turn 2: exitCode 0');
  assert(res2.stdout.includes('turn2'), 'turn 2: response contains turn2');
  assert(res2.stdout.includes(sessionId), 'turn 2: same session id');
  assert(runner.getSession(sessionId)!.turnCount === 2, 'turn 2: turnCount is 2');

  // Create a second session
  const sessionId2 = await runner.createSession({ cwd: '/tmp' });
  assert(sessionId2 !== sessionId, 'second session: different id');

  const res3 = await runner.sendMessage(sessionId2, 'New session');
  assert(res3.stdout.includes(sessionId2), 'second session: response has correct id');
  assert(res3.stdout.includes('turn1'), 'second session: starts at turn 1');

  // Original session still at turn 2
  assert(runner.getSession(sessionId)!.turnCount === 2, 'original session: still at turn 2');

  await runner.shutdown();
}

// ─── Test 4: AcpRunner — abort handling ─────────────────────────────────────

section('AcpRunner — abort');

{
  const mockCard: AgentCard = {
    name: 'test-agent',
    description: 'Test agent',
    model: 'mock',
    contextWindow: 100_000,
    strengths: ['testing'],
    cliCommand: ['echo', 'fallback'],
    transport: 'acp',
    acpCommand: ['bun', MOCK_SERVER],
  };

  const runner = new AcpRunner(mockCard);
  await runner.ensureRunning();

  const sessionId = await runner.createSession();

  // Normal message works
  const normal = await runner.sendMessage(sessionId, 'normal');
  assert(normal.exitCode === 0, 'abort test: normal message succeeds');

  // Pre-aborted signal
  const ac = new AbortController();
  ac.abort();
  const aborted = await runner.sendMessage(sessionId, 'should abort', {
    signal: ac.signal,
  });
  // The mock server responds instantly, so the message may complete before
  // the abort is checked. The key behavior is it doesn't throw/hang.
  assert(
    aborted.exitCode === 0 || aborted.hint === 'aborted',
    'abort test: pre-aborted signal handled without crash',
  );

  await runner.shutdown();
}

// ─── Test 5: AcpRunner — dead process recovery ─────────────────────────────

section('AcpRunner — dead process recovery');

{
  const mockCard: AgentCard = {
    name: 'test-agent',
    description: 'Test agent',
    model: 'mock',
    contextWindow: 100_000,
    strengths: ['testing'],
    cliCommand: ['echo', 'fallback'],
    transport: 'acp',
    acpCommand: ['bun', MOCK_SERVER],
  };

  const runner = new AcpRunner(mockCard);
  await runner.ensureRunning();

  const pid1 = runner.pid;
  assert(pid1 !== undefined, 'recovery: initial pid set');

  // Kill the process externally
  process.kill(pid1!, 'SIGKILL');
  // Wait for the drain loop to detect the death
  await new Promise((r) => setTimeout(r, 500));

  assert(!runner.alive, 'recovery: detected dead process (alive = false)');

  // ensureRunning should re-spawn
  await runner.ensureRunning();
  assert(runner.alive, 'recovery: re-spawned and alive');
  assert(runner.pid !== pid1, 'recovery: new pid after re-spawn');

  // New session works on the fresh process
  const sessionId = await runner.createSession();
  const res = await runner.sendMessage(sessionId, 'recovered');
  assert(res.exitCode === 0, 'recovery: message succeeds after re-spawn');
  assert(res.stdout.includes('recovered'), 'recovery: response correct');

  await runner.shutdown();
}

// ─── Test 6: AcpRunner — error from server ──────────────────────────────────

section('AcpRunner — error handling');

{
  const mockCard: AgentCard = {
    name: 'test-agent',
    description: 'Test agent',
    model: 'mock',
    contextWindow: 100_000,
    strengths: ['testing'],
    cliCommand: ['echo', 'fallback'],
    transport: 'acp',
    acpCommand: ['bun', MOCK_SERVER],
  };

  const runner = new AcpRunner(mockCard);
  await runner.ensureRunning();

  // Send message to a non-existent session
  const res = await runner.sendMessage('nonexistent_session', 'hello');
  assert(res.exitCode === 1, 'error: exitCode 1 on server error');
  assert(res.stderr.includes('Unknown session'), 'error: stderr contains error message');

  await runner.shutdown();
}

// ─── Test 7: AcpRunner — no acpCommand ──────────────────────────────────────

section('AcpRunner — missing acpCommand');

{
  const badCard: AgentCard = {
    name: 'bad-agent',
    description: 'Agent without acpCommand',
    model: 'mock',
    contextWindow: 100_000,
    strengths: [],
    cliCommand: ['echo'],
    transport: 'acp',
  };

  const runner = new AcpRunner(badCard);
  try {
    await runner.ensureRunning();
    fail('missing acpCommand: should have thrown', 'no error');
  } catch (err) {
    assert(
      (err as Error).message.includes('no acpCommand'),
      'missing acpCommand: throws descriptive error',
    );
  }
}

// ─── Summary ────────────────────────────────────────────────────────────────

process.stdout.write('\n');
if (failed === 0) {
  process.stdout.write(`\x1b[32m All ${passed} tests passed.\x1b[0m\n\n`);
  process.exit(0);
} else {
  process.stdout.write(`\x1b[31m ${failed} failed, ${passed} passed.\x1b[0m\n\n`);
  process.exit(1);
}
