import {
  listContextIds,
  readContextMeta,
  readAffinityHolder,
  archiveContext,
  purgeArchivedOlderThan,
  ContextNotFoundError,
} from '../transports/mailbox.ts';
import { log } from '../logger.ts';

/**
 * TTL sweeper.
 *
 * Periodically scans active contexts, archives any whose lastUsed has
 * exceeded its ttlMs (and isn't currently held by an alive worker), then
 * purges archived contexts older than `archivedRetentionMs`.
 *
 * Designed to run forever in the background of the supervisor process,
 * yielding control between contexts so a sweep over hundreds of dirs
 * doesn't starve task processing. A single corrupt context never aborts
 * the sweep — errors are logged and the loop continues.
 */

export interface SweepResult {
  agentsScanned: number;
  contextsScanned: number;
  contextsArchived: number;
  archivedPurged: number;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_ARCHIVED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** True if `pid` is a live process on this host. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true; // exists but not ours
    // Anything else: be conservative — treat as alive so we don't archive
    // a context that might still be in use.
    return true;
  }
}

/**
 * One pass of the sweeper:
 *   1. enumerate active contexts;
 *   2. for each, archive if (now - lastUsed) > ttlMs AND no live affinity holder;
 *   3. purge archived contexts older than archivedRetentionMs.
 *
 * Each context is processed in its own try/catch — a single corrupt
 * meta.json can't stop the rest of the sweep.
 */
export async function sweepOnce(
  agentName: string,
  opts: { archivedRetentionMs?: number } = {}
): Promise<SweepResult> {
  const archivedRetentionMs =
    opts.archivedRetentionMs ?? DEFAULT_ARCHIVED_RETENTION_MS;

  const result: SweepResult = {
    agentsScanned: 1,
    contextsScanned: 0,
    contextsArchived: 0,
    archivedPurged: 0,
  };

  let ids: string[];
  try {
    ids = await listContextIds(agentName);
  } catch (err) {
    log({
      event: 'sweep_failed',
      agent: agentName,
      reason: 'listContextIds',
      error: (err as Error).message,
    });
    return result;
  }

  const now = Date.now();
  for (const contextId of ids) {
    result.contextsScanned++;
    try {
      const meta = await readContextMeta(agentName, contextId);
      const idleMs = now - new Date(meta.lastUsed).getTime();
      if (idleMs <= meta.ttlMs) continue; // fresh

      // If a live affinity sentinel exists, don't archive — an active
      // session is still using this context. The sentinel will be cleared
      // (release or dead-pid recovery) before TTL has any chance to bite.
      const holderPid = await readAffinityHolder(agentName, contextId);
      if (holderPid !== null && isPidAlive(holderPid)) continue;

      await archiveContext(agentName, contextId, 'ttl');
      log({
        event: 'context_archived',
        agent: agentName,
        contextId,
        reason: 'ttl',
      });
      result.contextsArchived++;
    } catch (err) {
      // ContextNotFoundError just means another process archived it
      // between listContextIds and our read — benign.
      if (err instanceof ContextNotFoundError) continue;
      log({
        event: 'sweep_failed',
        agent: agentName,
        contextId,
        reason: 'context_eval',
        error: (err as Error).message,
      });
      // Continue: one bad context shouldn't stop the sweep.
    }
  }

  try {
    result.archivedPurged = await purgeArchivedOlderThan(
      agentName,
      archivedRetentionMs
    );
  } catch (err) {
    log({
      event: 'sweep_failed',
      agent: agentName,
      reason: 'purge',
      error: (err as Error).message,
    });
  }

  return result;
}

/**
 * Run sweepOnce on a recurring interval until the AbortSignal fires.
 *
 * Errors in a single sweep are logged but never crash the loop. On abort
 * the loop returns at the next tick (within `intervalMs` of abort, or
 * sooner if the abort fires while sleeping).
 *
 * Returns when the signal is aborted.
 */
export async function startSweeper(
  agentName: string,
  opts: {
    intervalMs?: number;
    archivedRetentionMs?: number;
    signal: AbortSignal;
  }
): Promise<void> {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const archivedRetentionMs =
    opts.archivedRetentionMs ?? DEFAULT_ARCHIVED_RETENTION_MS;
  const { signal } = opts;

  while (!signal.aborted) {
    try {
      const r = await sweepOnce(agentName, { archivedRetentionMs });
      if (r.contextsArchived > 0 || r.archivedPurged > 0) {
        log({
          event: 'sweep_completed',
          agent: agentName,
          message: `scanned=${r.contextsScanned} archived=${r.contextsArchived} purged=${r.archivedPurged}`,
        });
      }
    } catch (err) {
      // sweepOnce already swallows per-context errors; this catches
      // anything truly unexpected so the loop stays alive.
      log({
        event: 'sweep_failed',
        agent: agentName,
        reason: 'unexpected',
        error: (err as Error).message,
      });
    }

    if (signal.aborted) break;

    // Abort-aware sleep: resolve early if the signal fires.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, intervalMs);
      // setTimeout in Bun returns a Timer with .unref(); guard for portability.
      const t = timer as unknown as { unref?: () => void };
      if (typeof t.unref === 'function') t.unref();
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
