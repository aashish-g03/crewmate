#!/usr/bin/env bun
/**
 * Smoke test for the v1.1 supervisor-side lifecycle:
 *   - dead-pid affinity sentinel recovery
 *   - TTL sweeper (one-shot + loop)
 *   - archived-context purge by retention age
 *
 * Run:  bun scripts/probe-lifecycle.ts
 * Uses a temp CREWMATE_HOME so the user's ~/.crewmate is untouched.
 *
 * Exits 0 on success, 1 on the first failure.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

if (!process.env.CREWMATE_HOME) {
  const tmp = path.join(
    os.tmpdir(),
    `crewmate-lifecycle-probe-${process.pid}-${Date.now()}`
  );
  process.env.CREWMATE_HOME = tmp;
}
const HOME = process.env.CREWMATE_HOME!;

import {
  ensureContextsTree,
  affinityFile,
  archivedContextDir,
  contextDir,
  contextMetaFile,
  logFile,
} from '../src/paths.ts';
import {
  createContext,
  readContextMeta,
  writeContextMeta,
} from '../src/transports/mailbox.ts';
import { recoverDeadAffinity } from '../src/lifecycle/affinity-recovery.ts';
import { sweepOnce, startSweeper } from '../src/lifecycle/sweeper.ts';

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

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function writeAffinitySentinel(
  agent: string,
  contextId: string,
  workerPid: number
): Promise<void> {
  const dest = affinityFile(agent, contextId);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(
    dest,
    JSON.stringify({ workerPid, claimedAt: new Date().toISOString() }, null, 2) +
      '\n',
    'utf8'
  );
}

/**
 * Pick a definitely-dead PID. Spawn /usr/bin/true, wait for it to exit,
 * and use that pid. macOS kill(pid, 0) returns ESRCH immediately after.
 * The 99999 trick from the spec is not portable across pid_max settings,
 * so we use the actual-dead-process technique that probe-storage uses.
 */
async function spawnAndCollectDeadPid(): Promise<number> {
  const proc = Bun.spawn(['/usr/bin/true'], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const pid = proc.pid;
  await proc.exited;
  await new Promise((r) => setTimeout(r, 50));
  // Sanity: confirm dead.
  try {
    process.kill(pid, 0);
    throw new Error(`expected pid ${pid} to be dead but it's alive`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') throw err;
  }
  return pid;
}

async function backdateContextLastUsed(
  agent: string,
  contextId: string,
  msAgo: number,
  archived: boolean
): Promise<void> {
  // For archived contexts the meta lives under .archived/<id>/meta.json,
  // not contexts/<id>/meta.json — use the path helpers directly.
  const metaPath = archived
    ? path.join(archivedContextDir(agent, contextId), 'meta.json')
    : contextMetaFile(agent, contextId);
  const raw = JSON.parse(await fs.readFile(metaPath, 'utf8')) as {
    lastUsed: string;
    [k: string]: unknown;
  };
  raw.lastUsed = new Date(Date.now() - msAgo).toISOString();
  await fs.writeFile(metaPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
}

async function main(): Promise<void> {
  console.log(`[probe] CREWMATE_HOME=${HOME}`);
  await fs.rm(HOME, { recursive: true, force: true });
  await ensureContextsTree(AGENT);
  ok('temp home prepared');

  // ─── 1. Dead-pid affinity recovery ────────────────────────────────────────
  try {
    const deadPid = await spawnAndCollectDeadPid();
    const ctxDead = 'ctx_zzzzzzzz';
    await writeAffinitySentinel(AGENT, ctxDead, deadPid);

    const recovered1 = await recoverDeadAffinity(AGENT);
    assert(recovered1 === 1, `expected 1 recovery, got ${recovered1}`);
    assert(
      !(await fileExists(affinityFile(AGENT, ctxDead))),
      'dead-pid sentinel must be unlinked'
    );

    const recovered2 = await recoverDeadAffinity(AGENT);
    assert(recovered2 === 0, `2nd pass: expected 0 recoveries, got ${recovered2}`);

    // Alive sentinel must NOT be touched.
    const ctxAlive = 'ctx_yyyyyyyy';
    await writeAffinitySentinel(AGENT, ctxAlive, process.pid);
    const recovered3 = await recoverDeadAffinity(AGENT);
    assert(recovered3 === 0, `alive sentinel: expected 0 recoveries, got ${recovered3}`);
    assert(
      await fileExists(affinityFile(AGENT, ctxAlive)),
      'alive sentinel must remain'
    );
    // Cleanup so it doesn't bleed into the sweeper test.
    await fs.unlink(affinityFile(AGENT, ctxAlive));
    ok('affinity recovery: dead pid unlinked, alive pid preserved');
  } catch (err) {
    fail('affinity recovery', err);
  }

  // ─── 2. TTL sweeper (one-shot) ────────────────────────────────────────────
  let ctxA = '', ctxB = '', ctxC = '';
  try {
    const a = await createContext(AGENT, { contextId: 'ctx_aaaaaaaa' });
    const b = await createContext(AGENT, { contextId: 'ctx_bbbbbbbb' });
    const c = await createContext(AGENT, { contextId: 'ctx_cccccccc' });
    ctxA = a.contextId; ctxB = b.contextId; ctxC = c.contextId;

    // Backdate ctxA: 1h ago, ttl 30min → expired.
    const aMeta = await readContextMeta(AGENT, ctxA);
    await writeContextMeta(AGENT, ctxA, {
      ...aMeta,
      lastUsed: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      ttlMs: 30 * 60 * 1000,
    });
    // ctxB: 5 min ago, ttl 30 min → fresh.
    const bMeta = await readContextMeta(AGENT, ctxB);
    await writeContextMeta(AGENT, ctxB, {
      ...bMeta,
      lastUsed: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      ttlMs: 30 * 60 * 1000,
    });
    // ctxC: 1h ago, ttl 30 min, BUT alive affinity → must NOT archive.
    const cMeta = await readContextMeta(AGENT, ctxC);
    await writeContextMeta(AGENT, ctxC, {
      ...cMeta,
      lastUsed: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      ttlMs: 30 * 60 * 1000,
    });
    await writeAffinitySentinel(AGENT, ctxC, process.pid);

    const r = await sweepOnce(AGENT, { archivedRetentionMs: 7 * 24 * 3600 * 1000 });
    assert(r.contextsScanned === 3, `scanned ${r.contextsScanned}`);
    assert(r.contextsArchived === 1, `archived ${r.contextsArchived}`);
    assert(r.archivedPurged === 0, `purged ${r.archivedPurged}`);

    // ctxA gone from active, present in archived
    assert(!(await fileExists(contextDir(AGENT, ctxA))), 'ctxA active should be gone');
    assert(
      await fileExists(archivedContextDir(AGENT, ctxA)),
      'ctxA archived should exist'
    );
    // ctxB and ctxC still active
    assert(await fileExists(contextDir(AGENT, ctxB)), 'ctxB active should remain');
    assert(await fileExists(contextDir(AGENT, ctxC)), 'ctxC active should remain (alive affinity)');
    ok('sweepOnce: ctxA archived, ctxB fresh, ctxC protected by alive affinity');
  } catch (err) {
    fail('sweepOnce TTL archive', err);
  }

  // ─── 3. purgeArchivedOlderThan via sweepOnce ──────────────────────────────
  try {
    // Backdate ctxA inside .archived/ to 8 days ago.
    await backdateContextLastUsed(AGENT, ctxA, 8 * 24 * 60 * 60 * 1000, true);
    const r = await sweepOnce(AGENT, {
      archivedRetentionMs: 7 * 24 * 60 * 60 * 1000,
    });
    assert(r.archivedPurged === 1, `expected 1 purge, got ${r.archivedPurged}`);
    assert(
      !(await fileExists(archivedContextDir(AGENT, ctxA))),
      'ctxA archived dir should be gone after purge'
    );
    ok('sweepOnce: purged 8-day-old archived context');
  } catch (err) {
    fail('sweepOnce purge', err);
  }

  // ─── 4. Sweeper loop with abort ───────────────────────────────────────────
  try {
    // Capture log size BEFORE so we can scan only new entries for sweep_failed.
    const logPath = logFile();
    let beforeSize = 0;
    try {
      beforeSize = (await fs.stat(logPath)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    const ctrl = new AbortController();
    const startedAt = Date.now();
    const loop = startSweeper(AGENT, {
      intervalMs: 1000,
      signal: ctrl.signal,
    });
    await new Promise((r) => setTimeout(r, 2500));
    ctrl.abort();
    const abortedAt = Date.now();
    await loop;
    const stoppedAt = Date.now();
    const stopLatency = stoppedAt - abortedAt;
    assert(
      stopLatency < 500,
      `loop should stop within 500ms of abort, took ${stopLatency}ms`
    );
    const totalRun = stoppedAt - startedAt;
    assert(totalRun >= 2500, `loop should have run ≥2.5s, ran ${totalRun}ms`);

    // Read NEW log lines and ensure no sweep_failed events appeared.
    let logRaw = '';
    try {
      const fh = await fs.open(logPath, 'r');
      try {
        const stat = await fh.stat();
        const size = stat.size;
        if (size > beforeSize) {
          const buf = Buffer.alloc(size - beforeSize);
          await fh.read(buf, 0, buf.length, beforeSize);
          logRaw = buf.toString('utf8');
        }
      } finally {
        await fh.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const failedLines = logRaw
      .split('\n')
      .filter((l) => l.includes('"event":"sweep_failed"'));
    assert(
      failedLines.length === 0,
      `unexpected sweep_failed events: ${failedLines.join(' | ')}`
    );
    ok(`sweeper loop: ran ${totalRun}ms, stopped ${stopLatency}ms after abort, no sweep_failed`);
  } catch (err) {
    fail('sweeper loop', err);
  }

  console.log('\n[probe] all checks passed');
  await fs.rm(HOME, { recursive: true, force: true });
}

main().catch((err) => fail('main', err));
