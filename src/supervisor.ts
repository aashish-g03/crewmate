import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Subprocess } from 'bun';
import { loadAgentCard, loadAgentConfig } from './transports/mailbox.ts';
import {
  ensureAgentTree,
  homeDir,
  inboxDir,
  workersDir,
} from './paths.ts';
import { log, closeLogger } from './logger.ts';
import { recoverDeadAffinity } from './lifecycle/affinity-recovery.ts';
import { startSweeper } from './lifecycle/sweeper.ts';

/**
 * Recover orphaned tasks: scan workers/<pid>/ subdirs, and for each pid
 * that's no longer alive (`process.kill(pid, 0)` → ESRCH), atomically
 * rename its task files back into inbox/ for re-claim by a healthy worker.
 *
 * Called at supervisor startup (sweeps state from a previous crash) and
 * after each worker_died event (sweeps tasks owned by the just-dead pid).
 *
 * Edge cases:
 * - If the inbox already has a file with the same UUID name (impossible in
 *   practice — UUIDs are unique — but defensive), skip and log.
 * - If process.kill throws EPERM, the pid exists but we don't own it; leave
 *   alone.
 * - We don't delete the empty workers/<pid>/ dir here; that's harmless and
 *   would race with a worker about to write its own dir on startup.
 */
async function recoverOrphans(agentName: string): Promise<number> {
  const root = workersDir(agentName);
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }

  let recovered = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pidStr = entry.name;
    const pid = Number(pidStr);
    if (!Number.isInteger(pid) || pid <= 0) continue;

    let alive: boolean;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') alive = false;
      else if (code === 'EPERM') alive = true; // exists but not ours
      else throw err;
    }
    if (alive) continue;

    const workerPath = path.join(root, pidStr);
    let files: string[];
    try {
      files = await fs.readdir(workerPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.task.json')) continue;
      const taskId = file.replace(/\.task\.json$/, '');
      const orphan = path.join(workerPath, file);
      const requeued = path.join(inboxDir(agentName), file);
      try {
        await fs.rename(orphan, requeued);
        log({
          event: 'task_requeued',
          agent: agentName,
          taskId,
          orphanPid: pid,
          reason: 'worker died mid-task',
        });
        recovered++;
      } catch (err) {
        log({
          event: 'task_requeue_failed',
          agent: agentName,
          taskId,
          orphanPid: pid,
          error: (err as Error).message,
        });
      }
    }
    // Best-effort cleanup of the now-empty dead-pid dir.
    try {
      await fs.rmdir(workerPath);
    } catch {
      /* not empty (logs etc.) — leave it */
    }
  }
  return recovered;
}

/**
 * Pool supervisor.
 *
 * Spawns N child workers via `Bun.spawn`, each running src/worker.ts with
 * CREWMATE_AGENT set. Supervises with an exit-listener restart loop:
 * if a worker exits unexpectedly we re-spawn (with a small backoff to avoid
 * tight crash-loops). On SIGINT/SIGTERM we propagate down and wait briefly.
 */

const RESTART_BACKOFF_MS = 1000;
const SHUTDOWN_GRACE_MS = 3000;

interface PoolEntry {
  proc: Subprocess;
  slot: number;
  startedAt: number;
}

export async function runSupervisor(
  agentName: string,
  opts: { workersOverride?: number } = {}
): Promise<void> {
  const card = await loadAgentCard(agentName);
  const config = await loadAgentConfig(agentName);
  await ensureAgentTree(agentName);

  // Sweep state from any previous run before spawning fresh workers.
  const startupRecovered = await recoverOrphans(agentName);
  if (startupRecovered > 0) {
    process.stderr.write(
      `[crewmate] recovered ${startupRecovered} orphaned task(s) from prior run\n`
    );
  }
  // v1.1: also clear dead-pid affinity sentinels so future tasks can claim
  // contexts whose previous holder died. Independent of recoverOrphans —
  // a worker may have died holding affinity but with no in-flight task.
  try {
    const affinityRecovered = await recoverDeadAffinity(agentName);
    if (affinityRecovered > 0) {
      process.stderr.write(
        `[crewmate] recovered ${affinityRecovered} dead-pid affinity sentinel(s)\n`
      );
    }
  } catch (err) {
    log({
      event: 'affinity_recovery_failed',
      agent: agentName,
      error: (err as Error).message,
    });
  }

  const minWorkers =
    opts.workersOverride && opts.workersOverride > 0
      ? opts.workersOverride
      : config.poolSize;
  const maxWorkers = Math.max(minWorkers, config.maxWorkers ?? 5);

  const workerScript = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'worker.ts'
  );

  const pool = new Map<number, PoolEntry>();
  let shuttingDown = false;

  // v1.1: TTL sweeper runs in the background of the supervisor process.
  // We hold the controller so shutdown() can abort the loop cleanly.
  const sweeperController = new AbortController();
  const sweeperPromise = startSweeper(agentName, {
    signal: sweeperController.signal,
  }).catch((err) => {
    // startSweeper itself shouldn't throw — it logs sweep_failed and
    // continues. But surface anything truly catastrophic.
    log({
      event: 'sweeper_crashed',
      agent: agentName,
      error: (err as Error).message,
    });
  });

  const spawnOne = (slot: number): void => {
    if (shuttingDown) return;
    const proc = Bun.spawn(['bun', workerScript], {
      env: {
        ...process.env,
        CREWMATE_AGENT: agentName,
        CREWMATE_HOME: homeDir(),
      },
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    pool.set(slot, { proc, slot, startedAt: Date.now() });

    void proc.exited.then(async (code) => {
      pool.delete(slot);
      if (shuttingDown) return;
      log({
        event: 'worker_died',
        agent: agentName,
        pid: proc.pid,
        exitCode: code,
        reason: 'unexpected exit, restarting',
      });
      // Re-queue any task this worker had claimed before crashing.
      try {
        const n = await recoverOrphans(agentName);
        if (n > 0) {
          process.stderr.write(
            `[crewmate] re-queued ${n} task(s) from died worker pid=${proc.pid}\n`
          );
        }
      } catch (err) {
        log({
          event: 'orphan_recovery_failed',
          agent: agentName,
          error: (err as Error).message,
        });
      }
      // v1.1: a dead worker may have held affinity sentinels for in-flight
      // contexts. Free them so the next claim can take over. Independent of
      // recoverOrphans (a worker can hold affinity without an in-flight
      // task — between turns).
      try {
        const a = await recoverDeadAffinity(agentName);
        if (a > 0) {
          process.stderr.write(
            `[crewmate] recovered ${a} affinity sentinel(s) from died worker pid=${proc.pid}\n`
          );
        }
      } catch (err) {
        log({
          event: 'affinity_recovery_failed',
          agent: agentName,
          error: (err as Error).message,
        });
      }
      setTimeout(() => spawnOne(slot), RESTART_BACKOFF_MS).unref();
    });
  };

  for (let i = 0; i < minWorkers; i++) spawnOne(i);

  log({
    event: 'pool_started',
    agent: agentName,
    poolSize: minWorkers,
    message: `Supervising ${minWorkers}→${maxWorkers} ${card.name} workers (auto-scale)`,
  });
  process.stderr.write(
    `[crewmate] pool up: ${agentName} x${minWorkers} (max ${maxWorkers}, model=${card.model})\n`
  );

  // Auto-scale: check inbox depth every 2s, spawn more workers if tasks are queuing
  let nextSlot = minWorkers;
  const scaleInterval = setInterval(async () => {
    if (shuttingDown) return;
    if (pool.size >= maxWorkers) return;
    try {
      const inbox = inboxDir(agentName);
      const entries = await fs.readdir(inbox);
      const queued = entries.filter(f => f.endsWith('.task.json')).length;
      if (queued > 0 && pool.size < maxWorkers) {
        const toSpawn = Math.min(queued, maxWorkers - pool.size);
        for (let i = 0; i < toSpawn; i++) {
          spawnOne(nextSlot++);
        }
        log({
          event: 'pool_scaled_up',
          agent: agentName,
          poolSize: pool.size,
          message: `scaled to ${pool.size} workers (${queued} tasks queued)`,
        });
        process.stderr.write(
          `[crewmate] auto-scaled to ${pool.size} workers (${queued} tasks queued)\n`
        );
      }
    } catch {
      // inbox not ready yet, skip
    }
  }, 2000);
  scaleInterval.unref();

  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(scaleInterval);
    log({ event: 'pool_stopped', agent: agentName, reason: sig });
    process.stderr.write(`[crewmate] shutting down (${sig})\n`);

    // Abort the sweeper first; we don't want a sweep racing with the
    // workers as they shut down. Wait briefly (≤500ms) for any in-flight
    // sweep to settle but don't block forever — a wedged sweep can't
    // hold up termination.
    sweeperController.abort();
    await Promise.race([
      sweeperPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 500).unref()),
    ]);

    for (const entry of pool.values()) {
      try {
        entry.proc.kill('SIGTERM');
      } catch {
        /* already exited */
      }
    }

    const killTimer = setTimeout(() => {
      for (const entry of pool.values()) {
        try {
          entry.proc.kill('SIGKILL');
        } catch {
          /* already exited */
        }
      }
    }, SHUTDOWN_GRACE_MS);

    await Promise.allSettled(
      Array.from(pool.values()).map((e) => e.proc.exited)
    );
    clearTimeout(killTimer);
    await closeLogger();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Block forever — exits via shutdown()
  await new Promise<void>(() => {});
}
