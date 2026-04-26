#!/usr/bin/env bun
/**
 * End-to-end smoke test for v1.1 worker-side context handling.
 *
 * Spawns a real gemini-worker pool (poolSize=1 for determinism), then writes
 * task envelopes directly into the inbox (since `crewmate send` does not yet
 * expose --new-context / --context flags — that's a Step 6 CLI change owned
 * by another agent). Polls the outbox for results. Verifies on-disk shape.
 *
 * Run: bun scripts/probe-context.ts
 *
 * Budget: ~60-90 seconds — three or four real Gemini round-trips.
 *
 * Exits 0 on success, 1 on first failure.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

// Set a temp CREWMATE_HOME *before* importing anything that resolves paths.
const TMP_HOME = path.join(
  os.tmpdir(),
  `crewmate-probe-ctx-${process.pid}-${Date.now()}`
);
process.env.CREWMATE_HOME = TMP_HOME;
const HOME = TMP_HOME;

import { writeTaskRequest, readTaskResult } from '../src/transports/mailbox.ts';
import { outboxResultPath, inboxDir } from '../src/paths.ts';
import type { TaskRequestInput, TaskResult } from '../src/envelope.ts';

const PROJECT_ROOT = path.resolve(import.meta.dir, '..');
const CLI = path.join(PROJECT_ROOT, 'src/cli.ts');
const AGENT = 'gemini-worker';

function ok(label: string): void {
  console.log(`[OK] ${label}`);
}

function fail(label: string, err: unknown): never {
  console.error(`[FAIL] ${label}: ${(err as Error).message ?? String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function waitForFile(p: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(p);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`waitForFile timeout: ${p}`);
}

/**
 * Drop a task envelope and poll the outbox for the result.
 * `extras` carries v1.1 fields (newContext / contextId / ownerHint).
 */
async function sendTask(
  prompt: string,
  extras: Partial<TaskRequestInput>,
  timeoutMs: number
): Promise<TaskResult> {
  const taskId = crypto.randomUUID();
  const req: TaskRequestInput = {
    taskId,
    agent: AGENT,
    prompt,
    timeoutMs: 90_000,
    createdAt: new Date().toISOString(),
    ...extras,
  };
  await writeTaskRequest(AGENT, req);
  process.stderr.write(
    `[probe] sent ${taskId} (newContext=${!!extras.newContext}, contextId=${extras.contextId ?? 'none'})\n`
  );
  const resultPath = outboxResultPath(AGENT, taskId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(resultPath);
      return await readTaskResult(resultPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`task ${taskId} timed out after ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  console.log(`[probe] CREWMATE_HOME=${HOME}`);
  await fs.rm(HOME, { recursive: true, force: true });
  await fs.mkdir(HOME, { recursive: true });

  // 1. Init.
  {
    const proc = Bun.spawn(['bun', CLI, 'init'], {
      env: { ...process.env, CREWMATE_HOME: HOME },
      cwd: PROJECT_ROOT,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const code = await proc.exited;
    if (code !== 0) fail('crewmate init', new Error(`exit=${code}`));
    ok('crewmate init');
  }

  // Override poolSize=1 for determinism.
  const configPath = path.join(HOME, AGENT, 'config.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({ poolSize: 1, timeoutMs: 120000 }, null, 2)
  );
  ok('config written (poolSize=1)');

  // 2. Spawn the pool.
  console.log('[probe] starting pool…');
  const pool = Bun.spawn(['bun', CLI, 'up', AGENT], {
    env: { ...process.env, CREWMATE_HOME: HOME },
    cwd: PROJECT_ROOT,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      pool.kill('SIGTERM');
      await Promise.race([
        pool.exited,
        new Promise((r) => setTimeout(r, 3000)),
      ]);
      try {
        pool.kill('SIGKILL');
      } catch {
        /* */
      }
    } catch {
      /* */
    }
  };
  process.on('exit', () => {
    void cleanup();
  });
  process.on('SIGINT', () => {
    void cleanup().then(() => process.exit(130));
  });

  try {
    // Wait up to 10s for inbox/.
    await waitForFile(inboxDir(AGENT), 10_000);
    ok('inbox/ exists');
    // Give the worker chokidar watcher a moment to attach.
    await new Promise((r) => setTimeout(r, 1000));

    // 3. newContext task.
    const epoch = Date.now();
    console.log('[probe] sending turn 1 (newContext)…');
    const r1 = await sendTask(
      `Reply with exactly the single token: TURN_ONE_${epoch}`,
      { newContext: true, ownerHint: 'probe' },
      120_000
    );
    assert(
      r1.status === 'completed',
      `turn 1 status='${r1.status}' (error=${r1.error}; result=${(r1.result || '').slice(0, 200)})`
    );
    assert(
      typeof r1.contextId === 'string' &&
        /^ctx_[a-z0-9]{8}$/.test(r1.contextId),
      `turn 1 contextId='${r1.contextId}' must be ctx_xxxxxxxx`
    );
    assert(
      r1.turnNumber === 1,
      `turn 1 turnNumber=${r1.turnNumber} (expected 1)`
    );
    assert(
      r1.result.includes(`TURN_ONE_${epoch}`),
      `turn 1 result missing token: ${r1.result.slice(0, 200)}`
    );
    const ctxId = r1.contextId!;
    ok(`turn 1 → ${ctxId}, turnNumber=1, token round-tripped`);

    // 4. Continuation.
    console.log('[probe] sending turn 2 (continue)…');
    const r2 = await sendTask(
      `Reply with exactly the single token: TURN_TWO_${epoch}`,
      { contextId: ctxId },
      120_000
    );
    assert(
      r2.status === 'completed',
      `turn 2 status='${r2.status}' (error=${r2.error}; result=${(r2.result || '').slice(0, 200)})`
    );
    assert(
      r2.contextId === ctxId,
      `turn 2 contextId='${r2.contextId}' (expected '${ctxId}')`
    );
    assert(
      r2.turnNumber === 2,
      `turn 2 turnNumber=${r2.turnNumber} (expected 2)`
    );
    assert(
      r2.result.includes(`TURN_TWO_${epoch}`),
      `turn 2 result missing token: ${r2.result.slice(0, 200)}`
    );
    ok(`turn 2 → ctxId stable, turnNumber=2`);

    // 5. On-disk shape: meta.json + turn_NNN.json.
    const ctxDir = path.join(HOME, AGENT, 'contexts', ctxId);
    const metaPath = path.join(ctxDir, 'meta.json');
    const turn1Path = path.join(ctxDir, 'turn_001.json');
    const turn2Path = path.join(ctxDir, 'turn_002.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as {
      contextId: string;
      turnCount: number;
      ownerHint?: string;
    };
    assert(
      meta.contextId === ctxId,
      `meta.contextId='${meta.contextId}' (expected '${ctxId}')`
    );
    assert(
      meta.turnCount === 2,
      `meta.turnCount=${meta.turnCount} (expected 2)`
    );
    assert(
      meta.ownerHint === 'probe',
      `meta.ownerHint='${meta.ownerHint}' (expected 'probe')`
    );
    const turn1 = JSON.parse(await fs.readFile(turn1Path, 'utf8')) as {
      prompt: string;
      response: string;
    };
    const turn2 = JSON.parse(await fs.readFile(turn2Path, 'utf8')) as {
      prompt: string;
      response: string;
    };
    assert(
      turn1.prompt.includes(`TURN_ONE_${epoch}`),
      `turn_001.prompt missing token`
    );
    assert(
      turn1.response.includes(`TURN_ONE_${epoch}`),
      `turn_001.response missing token`
    );
    assert(
      turn2.prompt.includes(`TURN_TWO_${epoch}`),
      `turn_002.prompt missing token`
    );
    assert(
      turn2.response.includes(`TURN_TWO_${epoch}`),
      `turn_002.response missing token`
    );
    // Crucially: stored prompt is the ORIGINAL, not concatenated. So turn_002
    // should NOT contain "Turn 1:" preface.
    assert(
      !turn2.prompt.includes('Turn 1:'),
      `turn_002.prompt should be original, not concatenated; got: ${turn2.prompt.slice(0, 200)}`
    );
    ok('on-disk meta + turn files validate (original prompts persisted)');

    // 6. Bogus (well-formed but nonexistent) contextId → context_not_found.
    //    The envelope schema's regex requires 8 chars in the alphabet; we use
    //    a valid-shape id we know was never minted.
    console.log('[probe] sending bogus contextId…');
    const validShapeBogus = `ctx_${'z'.repeat(8)}`; // ctx_zzzzzzzz — alphabet contains z
    const r3 = await sendTask(
      `Reply with: never_run_${epoch}`,
      { contextId: validShapeBogus },
      45_000
    );
    assert(
      r3.status === 'failed',
      `bogus turn status='${r3.status}' (expected 'failed')`
    );
    assert(
      r3.error === 'context_not_found',
      `bogus turn error='${r3.error}' (expected 'context_not_found')`
    );
    ok('bogus contextId → status=failed, error=context_not_found');

    // 7. v1-style task (no context fields) still works → catches v1 regressions.
    console.log('[probe] sending v1-style task (no context)…');
    const r4 = await sendTask(
      `Reply with exactly: V1_OK_${epoch}`,
      {},
      120_000
    );
    assert(
      r4.status === 'completed',
      `v1 status='${r4.status}' (error=${r4.error})`
    );
    assert(
      r4.contextId == null,
      `v1 result.contextId should be null/undefined, got '${r4.contextId}'`
    );
    assert(
      r4.turnNumber === undefined,
      `v1 result.turnNumber should be undefined, got ${r4.turnNumber}`
    );
    assert(
      r4.result.includes(`V1_OK_${epoch}`),
      `v1 result missing token: ${r4.result.slice(0, 200)}`
    );
    ok('v1-style task still completes with null contextId');

    console.log('\n[probe] all checks passed');
  } catch (err) {
    await cleanup();
    fail('probe', err);
  }
  await cleanup();
}

main().then(
  () => process.exit(0),
  (err) => fail('main', err)
);
