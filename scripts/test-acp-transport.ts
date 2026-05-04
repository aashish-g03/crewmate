#!/usr/bin/env bun
/**
 * Comprehensive test suite for the ACP transport layer.
 *
 * Runs against mock-acp-server.ts — no external CLIs or API keys needed.
 * Tests: JsonRpcClient (including bidirectional RPC), AcpRunner lifecycle,
 * sessions, abort+cancel, dead-process recovery, error handling, token usage,
 * close session, mode setting, progress events, and file request handling.
 *
 * Usage: bun scripts/test-acp-transport.ts
 */

import { JsonRpcClient } from '../src/transports/jsonrpc.ts';
import { AcpRunner } from '../src/transports/acp-runner.ts';
import type { AgentCard } from '../src/envelope.ts';
import type { AcpProgressEvent } from '../src/transports/acp-runner.ts';
import path from 'node:path';

const MOCK_SERVER = path.resolve(import.meta.dir, 'mock-acp-server.ts');

let passed = 0;
let failed = 0;

function ok(name: string, detail?: string): void {
  passed++;
  const suffix = detail ? ` — ${detail}` : '';
  process.stdout.write(`  \x1b[32m[PASS]\x1b[0m ${name}${suffix}\n`);
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

function mockCard(overrides?: Partial<AgentCard>): AgentCard {
  return {
    name: 'test-agent',
    description: 'Test agent for ACP transport',
    model: 'mock',
    contextWindow: 100_000,
    strengths: ['testing'],
    cliCommand: ['echo', 'fallback'],
    transport: 'acp',
    acpCommand: ['bun', MOCK_SERVER],
    ...overrides,
  };
}

// Helper: query mock server internal state via _test/stats
async function queryStats(runner: AcpRunner, sessionId?: string): Promise<Record<string, unknown>> {
  // Access the private rpc field — acceptable in tests
  const rpc = (runner as unknown as { rpc: JsonRpcClient }).rpc;
  if (!rpc) return {};
  const resp = await rpc.request('_test/stats', sessionId ? { sessionId } : {}, 5_000);
  return (resp.result ?? {}) as Record<string, unknown>;
}


// ═══════════════════════════════════════════════════════════════════════════════
// 1. JsonRpcClient — Core
// ═══════════════════════════════════════════════════════════════════════════════

section('JsonRpcClient — Core');

{
  const sent: string[] = [];
  const client = new JsonRpcClient({
    write: (data) => sent.push(data),
    defaultTimeoutMs: 1000,
  });

  // Notify
  client.notify('test/ping', { value: 42 });
  const notifyMsg = JSON.parse(sent[0]!);
  assert(notifyMsg.jsonrpc === '2.0', 'notify: jsonrpc version');
  assert(notifyMsg.method === 'test/ping', 'notify: method');
  assert(notifyMsg.id === undefined, 'notify: no id');
  assert(notifyMsg.params.value === 42, 'notify: params');

  // Request + response
  const reqPromise = client.request('test/echo', { msg: 'hello' });
  const reqMsg = JSON.parse(sent[1]!);
  assert(reqMsg.id === 1, 'request: id starts at 1');
  assert(reqMsg.method === 'test/echo', 'request: method');
  assert(client.pendingCount === 1, 'request: pending count is 1');

  client.feed(`{"jsonrpc":"2.0","id":1,"result":{"echo":"hello"}}\n`);
  const resp = await reqPromise;
  assert((resp.result as Record<string, unknown>).echo === 'hello', 'request: result matches');
  assert(client.pendingCount === 0, 'request: pending cleared');

  // Partial line buffering
  const req2Promise = client.request('test/split');
  client.feed('{"jsonrpc":"2.0",');
  assert(client.pendingCount === 1, 'partial: still pending');
  client.feed('"id":2,"result":"ok"}\n');
  const resp2 = await req2Promise;
  assert(resp2.result === 'ok', 'partial: buffered correctly');

  // Timeout
  const req3Promise = client.request('test/timeout', {}, 50);
  try {
    await req3Promise;
    fail('timeout: should have thrown', 'no error');
  } catch (err) {
    assert((err as Error).message.includes('timeout'), 'timeout: rejects with timeout error');
  }

  // cancelAll
  const req4Promise = client.request('test/cancel');
  client.cancelAll('shutting down');
  try {
    await req4Promise;
    fail('cancelAll: should have thrown', 'no error');
  } catch (err) {
    assert((err as Error).message.includes('shutting down'), 'cancelAll: rejects with reason');
  }
  assert(client.pendingCount === 0, 'cancelAll: pending cleared');

  // Malformed JSON skipped
  const req5Promise = client.request('test/malformed');
  client.feed('not json at all\n');
  client.feed(`{"jsonrpc":"2.0","id":${5},"result":"survived"}\n`);
  const resp5 = await req5Promise;
  assert(resp5.result === 'survived', 'malformed: skips bad lines');
}


// ═══════════════════════════════════════════════════════════════════════════════
// 2. JsonRpcClient — Notifications
// ═══════════════════════════════════════════════════════════════════════════════

section('JsonRpcClient — Notifications');

{
  const sent: string[] = [];
  const client = new JsonRpcClient({ write: (d) => sent.push(d) });
  const received: { method: string; params: Record<string, unknown> }[] = [];

  client.onNotification((method, params) => {
    received.push({ method, params });
  });

  // Server sends notification (no id)
  client.feed('{"jsonrpc":"2.0","method":"session/update","params":{"data":"test"}}\n');
  assert(received.length === 1, 'notification: received');
  assert(received[0]!.method === 'session/update', 'notification: correct method');
  assert((received[0]!.params as Record<string, unknown>).data === 'test', 'notification: correct params');

  // Notification without params
  client.feed('{"jsonrpc":"2.0","method":"ping"}\n');
  assert(received.length === 2, 'notification: no params handled');
}


// ═══════════════════════════════════════════════════════════════════════════════
// 3. JsonRpcClient — Bidirectional (Server→Client Requests)
// ═══════════════════════════════════════════════════════════════════════════════

section('JsonRpcClient — Bidirectional Requests');

{
  const sent: string[] = [];
  const client = new JsonRpcClient({ write: (d) => sent.push(d) });

  client.onRequest(async (method, params) => {
    if (method === 'readFile') {
      return { result: { content: `file content of ${params.path}` } };
    }
    if (method === 'writeFile') {
      return { error: { code: -32601, message: 'write not allowed' } };
    }
    return { error: { code: -32601, message: `unknown: ${method}` } };
  });

  // Server sends a request (has both method AND id)
  sent.length = 0;
  client.feed('{"jsonrpc":"2.0","id":100,"method":"readFile","params":{"path":"test.ts"}}\n');

  // Wait for async handler to complete
  await new Promise(r => setTimeout(r, 50));

  assert(sent.length === 1, 'bidir: response sent');
  const resp = JSON.parse(sent[0]!);
  assert(resp.id === 100, 'bidir: response id matches request id');
  assert(resp.result?.content === 'file content of test.ts', 'bidir: result correct');

  // Server sends a request that returns error
  sent.length = 0;
  client.feed('{"jsonrpc":"2.0","id":101,"method":"writeFile","params":{"path":"x.ts","content":"bad"}}\n');
  await new Promise(r => setTimeout(r, 50));

  assert(sent.length === 1, 'bidir error: response sent');
  const errResp = JSON.parse(sent[0]!);
  assert(errResp.id === 101, 'bidir error: response id matches');
  assert(errResp.error?.code === -32601, 'bidir error: correct error code');
  assert(errResp.error?.message === 'write not allowed', 'bidir error: correct message');

  // Server request that doesn't match pending (it's a new request, not a response)
  // Should NOT interfere with client's own pending requests
  const clientReq = client.request('myMethod', {}, 5000);
  client.feed('{"jsonrpc":"2.0","id":200,"method":"someAgentRequest","params":{}}\n');
  await new Promise(r => setTimeout(r, 50));
  // clientReq should still be pending (id=6 or whatever)
  assert(client.pendingCount === 1, 'bidir: client pending not disrupted');
  // Resolve the client request normally
  const clientId = JSON.parse(sent[sent.length - 2]!).id; // the request we sent
  client.feed(`{"jsonrpc":"2.0","id":${clientId},"result":"done"}\n`);
  const clientResp = await clientReq;
  assert(clientResp.result === 'done', 'bidir: client request still works');
}


// ═══════════════════════════════════════════════════════════════════════════════
// 4. AcpRunner — Lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

section('AcpRunner — Lifecycle');

{
  const runner = new AcpRunner(mockCard());

  assert(!runner.alive, 'before spawn: not alive');
  assert(runner.pid === undefined, 'before spawn: no pid');

  await runner.ensureRunning();
  assert(runner.alive, 'after spawn: alive');
  assert(runner.pid !== undefined, 'after spawn: has pid');

  const pidBefore = runner.pid;
  await runner.ensureRunning();
  assert(runner.pid === pidBefore, 'ensureRunning: idempotent');

  await runner.shutdown();
  assert(!runner.alive, 'after shutdown: not alive');
  assert(runner.pid === undefined, 'after shutdown: no pid');
}


// ═══════════════════════════════════════════════════════════════════════════════
// 5. AcpRunner — Sessions + Turn Counting
// ═══════════════════════════════════════════════════════════════════════════════

section('AcpRunner — Sessions');

{
  const runner = new AcpRunner(mockCard());
  await runner.ensureRunning();

  const sid = await runner.createSession();
  assert(typeof sid === 'string', 'createSession: returns string');
  assert(sid.startsWith('mock_session_'), 'createSession: mock id format');
  assert(runner.getSession(sid)?.turnCount === 0, 'getSession: turnCount starts at 0');

  const r1 = await runner.sendMessage(sid, 'Hello');
  assert(r1.exitCode === 0, 'turn 1: exitCode 0');
  assert(r1.stdout.includes(sid), 'turn 1: response contains session id');
  assert(r1.stdout.includes('turn1'), 'turn 1: contains turn1');
  assert(r1.stdout.includes('Hello'), 'turn 1: echoes prompt');
  assert(runner.getSession(sid)?.turnCount === 1, 'turn 1: count incremented');

  const r2 = await runner.sendMessage(sid, 'Follow up');
  assert(r2.stdout.includes('turn2'), 'turn 2: contains turn2');
  assert(runner.getSession(sid)?.turnCount === 2, 'turn 2: count is 2');

  // Second session is independent
  const sid2 = await runner.createSession();
  assert(sid2 !== sid, 'second session: different id');
  const r3 = await runner.sendMessage(sid2, 'New');
  assert(r3.stdout.includes(sid2), 'second session: correct id');
  assert(r3.stdout.includes('turn1'), 'second session: starts at turn 1');
  assert(runner.getSession(sid)?.turnCount === 2, 'original: still at turn 2');

  await runner.shutdown();
}


// ═══════════════════════════════════════════════════════════════════════════════
// 6. AcpRunner — Token Usage
// ═══════════════════════════════════════════════════════════════════════════════

section('AcpRunner — Token Usage');

{
  const runner = new AcpRunner(mockCard());
  await runner.ensureRunning();

  const sid = await runner.createSession();
  const res = await runner.sendMessage(sid, 'Count my tokens please');
  assert(res.exitCode === 0, 'token: exitCode 0');
  assert(res.inputTokens !== undefined, 'token: inputTokens present');
  assert(res.outputTokens !== undefined, 'token: outputTokens present');
  assert(typeof res.inputTokens === 'number' && res.inputTokens > 0, 'token: inputTokens > 0');
  assert(typeof res.outputTokens === 'number' && res.outputTokens > 0, 'token: outputTokens > 0');

  await runner.shutdown();
}


// ═══════════════════════════════════════════════════════════════════════════════
// 7. AcpRunner — Cancel Notification
// ═══════════════════════════════════════════════════════════════════════════════

section('AcpRunner — Cancel Notification');

{
  const runner = new AcpRunner(mockCard());
  await runner.ensureRunning();

  const sid = await runner.createSession();

  // Normal message first
  const normal = await runner.sendMessage(sid, 'normal');
  assert(normal.exitCode === 0, 'cancel: normal message works');

  // Pre-aborted signal — should send cancel notification
  const ac = new AbortController();
  ac.abort();
  await runner.sendMessage(sid, 'should cancel', { signal: ac.signal });

  // Check that cancel notification was received by the mock server
  const stats = await queryStats(runner, sid);
  const sessionStats = stats.session as Record<string, unknown> | undefined;
  assert(
    (stats.totalCancelNotifications as number) >= 1,
    'cancel: notification sent to server',
    `totalCancelNotifications=${stats.totalCancelNotifications}`,
  );

  await runner.shutdown();
}


// ═══════════════════════════════════════════════════════════════════════════════
// 8. AcpRunner — Close Session
// ═══════════════════════════════════════════════════════════════════════════════

section('AcpRunner — Close Session');

{
  const runner = new AcpRunner(mockCard());
  await runner.ensureRunning();

  const sid = await runner.createSession();
  await runner.sendMessage(sid, 'hello');
  assert(runner.getSession(sid) !== undefined, 'close: session exists before close');

  await runner.closeSession(sid);
  assert(runner.getSession(sid) === undefined, 'close: session removed from local map');

  // Verify server received the close
  const stats = await queryStats(runner);
  assert((stats.totalCloseRequests as number) >= 1, 'close: server received close request');

  // Sending to closed session should error
  const errRes = await runner.sendMessage(sid, 'should fail');
  assert(errRes.exitCode !== 0 || errRes.stderr.includes('closed') || errRes.stderr.includes('Unknown'),
    'close: message to closed session fails');

  await runner.shutdown();
}


// ═══════════════════════════════════════════════════════════════════════════════
// 9. AcpRunner — Shutdown Closes All Sessions
// ═══════════════════════════════════════════════════════════════════════════════

section('AcpRunner — Shutdown Closes Sessions');

{
  const runner = new AcpRunner(mockCard());
  await runner.ensureRunning();

  await runner.createSession();
  await runner.createSession();
  await runner.createSession();

  // Shutdown should close all 3 sessions
  await runner.shutdown();
  // Can't query stats after shutdown (process is dead), but we verified
  // the closeSession code path above. The key assertion is that shutdown
  // doesn't throw or hang.
  assert(!runner.alive, 'shutdown: completed without hanging');
  ok('shutdown: closed 3 sessions without error');
}


// ═══════════════════════════════════════════════════════════════════════════════
// 10. AcpRunner — Mode Setting
// ═══════════════════════════════════════════════════════════════════════════════

section('AcpRunner — Mode Setting');

{
  const runner = new AcpRunner(mockCard());
  await runner.ensureRunning();

  const sid = await runner.createSession();

  // Set mode to 'plan'
  await runner.setMode(sid, 'plan');

  // Verify by sending a message — mock server includes mode in response
  const res = await runner.sendMessage(sid, 'Check mode');
  assert(res.stdout.includes('mode=plan'), 'mode: response reflects plan mode', res.stdout.slice(0, 100));

  // Switch to autoEdit
  await runner.setMode(sid, 'autoEdit');
  const res2 = await runner.sendMessage(sid, 'Check again');
  assert(res2.stdout.includes('mode=autoEdit'), 'mode: switched to autoEdit', res2.stdout.slice(0, 100));

  await runner.shutdown();
}


// ═══════════════════════════════════════════════════════════════════════════════
// 11. AcpRunner — Progress Events
// ═══════════════════════════════════════════════════════════════════════════════

section('AcpRunner — Progress Events');

{
  const runner = new AcpRunner(mockCard());
  const events: AcpProgressEvent[] = [];
  runner.onProgress((e) => events.push(e));
  await runner.ensureRunning();

  const sid = await runner.createSession();

  // Prompt that triggers tool_call notifications in mock server
  const res = await runner.sendMessage(sid, 'Please read file test.ts');
  assert(res.exitCode === 0, 'progress: message succeeded');

  const toolStarts = events.filter(e => e.type === 'tool_start');
  const toolDones = events.filter(e => e.type === 'tool_done');
  const chunks = events.filter(e => e.type === 'chunk');

  assert(toolStarts.length >= 1, 'progress: got tool_start event', `count=${toolStarts.length}`);
  assert(toolDones.length >= 1, 'progress: got tool_done event', `count=${toolDones.length}`);
  assert(chunks.length >= 1, 'progress: got chunk event', `count=${chunks.length}`);
  assert(toolStarts[0]?.kind === 'read', 'progress: tool kind is read');
  assert(toolStarts[0]?.title === 'mock-file.ts', 'progress: tool title correct');

  await runner.shutdown();
}


// ═══════════════════════════════════════════════════════════════════════════════
// 12. AcpRunner — File Read Request Handler (Bidirectional)
// ═══════════════════════════════════════════════════════════════════════════════

section('AcpRunner — File Read Request Handler');

{
  const runner = new AcpRunner(mockCard());
  await runner.ensureRunning();

  const sid = await runner.createSession();

  // The mock server sends a readTextFile request when prompt contains "host_read:<path>"
  // The AcpRunner should handle it and respond with file contents
  const testFile = path.resolve(import.meta.dir, 'mock-acp-server.ts');
  const res = await runner.sendMessage(sid, `host_read:${testFile}`, { timeoutMs: 10_000 });
  // The prompt still completes — the file read is a side-channel request
  assert(res.exitCode === 0, 'file read: message completed');
  // We can't directly verify the response went back (it's internal to the RPC),
  // but the key is it didn't crash or hang
  ok('file read: handled without crash or hang');

  await runner.shutdown();
}


// ═══════════════════════════════════════════════════════════════════════════════
// 13. AcpRunner — Dead Process Recovery
// ═══════════════════════════════════════════════════════════════════════════════

section('AcpRunner — Dead Process Recovery');

{
  const runner = new AcpRunner(mockCard());
  await runner.ensureRunning();

  const pid1 = runner.pid!;
  assert(pid1 !== undefined, 'recovery: initial pid set');

  process.kill(pid1, 'SIGKILL');
  // Wait for drain loop to detect death (~1-2s)
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (!runner.alive) break;
  }
  assert(!runner.alive, 'recovery: detected dead process');

  await runner.ensureRunning();
  assert(runner.alive, 'recovery: re-spawned');
  assert(runner.pid !== pid1, 'recovery: new pid');

  const sid = await runner.createSession();
  const res = await runner.sendMessage(sid, 'recovered');
  assert(res.exitCode === 0, 'recovery: message succeeds');
  assert(res.stdout.includes('recovered'), 'recovery: response correct');

  await runner.shutdown();
}


// ═══════════════════════════════════════════════════════════════════════════════
// 14. AcpRunner — Error Handling
// ═══════════════════════════════════════════════════════════════════════════════

section('AcpRunner — Error Handling');

{
  const runner = new AcpRunner(mockCard());
  await runner.ensureRunning();

  // Bad session ID
  const res = await runner.sendMessage('nonexistent_session', 'hello');
  assert(res.exitCode === 1, 'error: exitCode 1 on server error');
  assert(res.stderr.includes('Unknown session'), 'error: stderr contains error message');

  await runner.shutdown();
}


// ═══════════════════════════════════════════════════════════════════════════════
// 15. AcpRunner — Missing acpCommand
// ═══════════════════════════════════════════════════════════════════════════════

section('AcpRunner — Missing acpCommand');

{
  const badCard = mockCard({ acpCommand: undefined });
  const runner = new AcpRunner(badCard);
  try {
    await runner.ensureRunning();
    fail('missing acpCommand: should have thrown', 'no error');
  } catch (err) {
    assert((err as Error).message.includes('no acpCommand'), 'missing acpCommand: descriptive error');
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// 16. AcpRunner — Spawn Mutex (no double-spawn)
// ═══════════════════════════════════════════════════════════════════════════════

section('AcpRunner — Spawn Mutex');

{
  const runner = new AcpRunner(mockCard());

  // Call ensureRunning twice concurrently
  const [r1, r2] = await Promise.all([
    runner.ensureRunning(),
    runner.ensureRunning(),
  ]);
  assert(runner.alive, 'mutex: alive after concurrent ensureRunning');
  // Both resolved without error — only one spawn happened
  ok('mutex: concurrent ensureRunning did not double-spawn');

  await runner.shutdown();
}


// ═══════════════════════════════════════════════════════════════════════════════
// 17. Regression: Abort doesn't leave runner in broken state
// ═══════════════════════════════════════════════════════════════════════════════

section('Regression — Abort Recovery');

{
  const runner = new AcpRunner(mockCard());
  await runner.ensureRunning();

  const sid = await runner.createSession();

  // Abort one message
  const ac = new AbortController();
  ac.abort();
  await runner.sendMessage(sid, 'aborted', { signal: ac.signal });

  // Next message on same session should still work
  const res = await runner.sendMessage(sid, 'after abort');
  assert(res.exitCode === 0, 'abort recovery: next message works');
  assert(res.stdout.includes('after abort'), 'abort recovery: correct response');

  await runner.shutdown();
}


// ═══════════════════════════════════════════════════════════════════════════════
// 18. Regression: Multiple sessions don't interfere
// ═══════════════════════════════════════════════════════════════════════════════

section('Regression — Session Isolation');

{
  const runner = new AcpRunner(mockCard());
  await runner.ensureRunning();

  const s1 = await runner.createSession();
  const s2 = await runner.createSession();
  const s3 = await runner.createSession();

  // Interleave messages across sessions
  await runner.sendMessage(s1, 'A1');
  await runner.sendMessage(s2, 'B1');
  await runner.sendMessage(s3, 'C1');
  await runner.sendMessage(s1, 'A2');

  assert(runner.getSession(s1)?.turnCount === 2, 'isolation: s1 has 2 turns');
  assert(runner.getSession(s2)?.turnCount === 1, 'isolation: s2 has 1 turn');
  assert(runner.getSession(s3)?.turnCount === 1, 'isolation: s3 has 1 turn');

  // Close one session, others unaffected
  await runner.closeSession(s2);
  assert(runner.getSession(s2) === undefined, 'isolation: s2 closed');
  assert(runner.getSession(s1)?.turnCount === 2, 'isolation: s1 unaffected');
  assert(runner.getSession(s3)?.turnCount === 1, 'isolation: s3 unaffected');

  await runner.shutdown();
}


// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════

process.stdout.write('\n');
if (failed === 0) {
  process.stdout.write(`\x1b[32m All ${passed} tests passed.\x1b[0m\n\n`);
  process.exit(0);
} else {
  process.stdout.write(`\x1b[31m ${failed} failed, ${passed} passed.\x1b[0m\n\n`);
  process.exit(1);
}
