#!/usr/bin/env bun
/**
 * Smoke test for the v1.1 mailbox storage layer.
 *
 * Run: CREWMATE_HOME=/tmp/crewmate-probe bun scripts/probe-storage.ts
 * (script sets a temp CREWMATE_HOME automatically if none is provided)
 *
 * Exits 0 on success, 1 on any failure.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

// Set a temp CREWMATE_HOME *before* importing anything that resolves paths.
if (!process.env.CREWMATE_HOME) {
  const tmp = path.join(os.tmpdir(), `crewmate-probe-${process.pid}-${Date.now()}`);
  process.env.CREWMATE_HOME = tmp;
}
const HOME = process.env.CREWMATE_HOME!;

import {
  createContext,
  appendContextTurn,
  readContextMeta,
  readContextTurns,
  listContextIds,
  archiveContext,
  tryClaimAffinity,
  releaseAffinity,
  readAffinityHolder,
  ContextNotFoundError,
} from '../src/transports/mailbox.ts';
import {
  archivedContextDir,
  contextDir,
  ensureContextsTree,
} from '../src/paths.ts';
import { mintContextId, isContextId } from '../src/util/context-id.ts';

const AGENT = 'probe-agent';

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

async function main(): Promise<void> {
  console.log(`[probe] CREWMATE_HOME=${HOME}`);

  // Clean slate.
  await fs.rm(HOME, { recursive: true, force: true });
  await ensureContextsTree(AGENT);
  ok('temp home prepared');

  // 0. Mint sanity.
  try {
    const id = mintContextId();
    assert(isContextId(id), `minted id ${id} must validate`);
    assert(id.startsWith('ctx_'), 'mint prefix');
    assert(id.length === 12, 'mint length');
    ok(`mintContextId produced ${id}`);
  } catch (err) {
    fail('mintContextId', err);
  }

  // 1. Create context.
  let ctxId: string;
  try {
    const meta = await createContext(AGENT, { ownerHint: 'probe-owner' });
    ctxId = meta.contextId;
    assert(isContextId(ctxId), 'created contextId is well-formed');
    assert(meta.turnCount === 0, 'turnCount starts at 0');
    assert(meta.ownerHint === 'probe-owner', 'ownerHint persisted');
    assert(meta.ttlMs === 30 * 60 * 1000, 'default ttl');
    // verify on-disk file too
    const onDisk = await readContextMeta(AGENT, ctxId);
    assert(onDisk.contextId === ctxId, 'meta.json round-trips');
    ok(`createContext → ${ctxId}`);
  } catch (err) {
    fail('createContext', err);
  }

  // 2. Append 3 turns.
  try {
    for (let i = 1; i <= 3; i++) {
      const taskId = crypto.randomUUID();
      const n = await appendContextTurn(AGENT, ctxId, {
        taskId,
        prompt: `prompt ${i}`,
        response: `response ${i}`,
        usage: { durationMs: 100 * i, exitCode: 0, stdoutBytes: 50 * i },
        timestamp: new Date().toISOString(),
      });
      assert(n === i, `turn number should be ${i}, got ${n}`);
    }
    const meta = await readContextMeta(AGENT, ctxId);
    assert(meta.turnCount === 3, `turnCount should be 3, got ${meta.turnCount}`);
    // lastUsed should be after `created`
    assert(
      new Date(meta.lastUsed).getTime() >= new Date(meta.created).getTime(),
      'lastUsed >= created'
    );
    ok('appended 3 turns; turnCount=3, lastUsed updated');
  } catch (err) {
    fail('appendContextTurn', err);
  }

  // 3. Read all turns back, verify order + content.
  try {
    const turns = await readContextTurns(AGENT, ctxId);
    assert(turns.length === 3, `expected 3 turns, got ${turns.length}`);
    for (let i = 0; i < 3; i++) {
      assert(
        turns[i]!.prompt === `prompt ${i + 1}`,
        `turn[${i}].prompt mismatch: ${turns[i]!.prompt}`
      );
      assert(
        turns[i]!.response === `response ${i + 1}`,
        `turn[${i}].response mismatch`
      );
      assert(
        turns[i]!.usage.durationMs === 100 * (i + 1),
        `turn[${i}].usage.durationMs mismatch`
      );
    }
    ok('readContextTurns returns 3 turns in order with correct content');
  } catch (err) {
    fail('readContextTurns', err);
  }

  // 4. Affinity: use process.pid (alive) for held-by-self / held-by-other.
  try {
    const ourPid = process.pid;
    const otherPid = process.pid; // same process, different "logical" pid in this test
    // First claim by ourPid → 'acquired'
    const r1 = await tryClaimAffinity(AGENT, ctxId, ourPid);
    assert(r1 === 'acquired', `1st claim: expected 'acquired', got '${r1}'`);

    // Same pid again → 'held-by-self'
    const r2 = await tryClaimAffinity(AGENT, ctxId, ourPid);
    assert(r2 === 'held-by-self', `2nd claim: expected 'held-by-self', got '${r2}'`);

    // Different but ALIVE pid: pick parent pid (always alive while we run)
    const ppid = process.ppid;
    assert(ppid > 0 && ppid !== ourPid, 'need a different alive pid for test');
    const r3 = await tryClaimAffinity(AGENT, ctxId, ppid);
    assert(r3 === 'held-by-other', `3rd claim from ppid: expected 'held-by-other', got '${r3}'`);

    // Read holder
    const holder = await readAffinityHolder(AGENT, ctxId);
    assert(holder === ourPid, `holder should be ${ourPid}, got ${holder}`);

    // Release as wrong pid → no-op
    await releaseAffinity(AGENT, ctxId, ppid);
    const stillHeld = await readAffinityHolder(AGENT, ctxId);
    assert(stillHeld === ourPid, 'release by wrong pid must not unlock');

    // Release as correct pid → gone
    await releaseAffinity(AGENT, ctxId, ourPid);
    const afterRelease = await readAffinityHolder(AGENT, ctxId);
    assert(afterRelease === null, 'release by owner must clear sentinel');

    // Dead-pid takeover: write a sentinel for a definitely-dead pid (we use
    // a synthesized very-high pid that we verify is dead). On macOS PIDs
    // wrap around 99999, but we can just spawn a process and let it exit.
    const deadPid = await spawnAndCollectPid();
    // Write sentinel manually so we control the contents.
    const { affinityFile } = await import('../src/paths.ts');
    const sentinelPath = affinityFile(AGENT, ctxId);
    await fs.writeFile(
      sentinelPath,
      JSON.stringify({ workerPid: deadPid, claimedAt: new Date().toISOString() }) + '\n',
      'utf8'
    );
    const r4 = await tryClaimAffinity(AGENT, ctxId, ourPid);
    assert(r4 === 'acquired', `dead-pid takeover: expected 'acquired', got '${r4}'`);
    await releaseAffinity(AGENT, ctxId, ourPid);
    ok('affinity: acquired / held-by-self / held-by-other / dead-pid takeover all correct');
  } catch (err) {
    fail('affinity', err);
  }

  // 5. Archive context.
  try {
    await archiveContext(AGENT, ctxId, 'explicit');
    // active dir should be gone
    let activeExists = true;
    try {
      await fs.stat(contextDir(AGENT, ctxId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') activeExists = false;
    }
    assert(!activeExists, 'active context dir should be gone after archive');
    // archived dir should exist
    const archStat = await fs.stat(archivedContextDir(AGENT, ctxId));
    assert(archStat.isDirectory(), 'archived dir should be a directory');
    // readContextMeta on the (now-missing) active context should throw ContextNotFoundError
    let threw = false;
    try {
      await readContextMeta(AGENT, ctxId);
    } catch (err) {
      threw = err instanceof ContextNotFoundError;
    }
    assert(threw, 'reading archived context via active path should throw ContextNotFoundError');
    ok(`archiveContext moved ${ctxId} to .archived/`);
  } catch (err) {
    fail('archiveContext', err);
  }

  // 6. listContextIds excludes archived.
  try {
    // create another active one to make the listing non-empty
    const second = await createContext(AGENT, {});
    const ids = await listContextIds(AGENT);
    assert(!ids.includes(ctxId), `archived ${ctxId} should NOT be listed`);
    assert(ids.includes(second.contextId), `active ${second.contextId} should be listed`);
    ok(`listContextIds returns active only: ${ids.join(', ')}`);
  } catch (err) {
    fail('listContextIds', err);
  }

  console.log('\n[probe] all checks passed');
  // Clean up the temp home.
  await fs.rm(HOME, { recursive: true, force: true });
}

/** Spawn a tiny process, wait for it to exit, return its (now-dead) pid. */
async function spawnAndCollectPid(): Promise<number> {
  const proc = Bun.spawn(['/usr/bin/true'], { stdout: 'ignore', stderr: 'ignore' });
  const pid = proc.pid;
  await proc.exited;
  // Give the kernel a tick to reap. On macOS, kill(pid, 0) returns ESRCH
  // immediately after exit in practice, but a yield is cheap insurance.
  await new Promise((r) => setTimeout(r, 50));
  return pid;
}

main().catch((err) => fail('main', err));
