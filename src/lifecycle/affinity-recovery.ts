import fs from 'node:fs/promises';
import { affinityRoot, affinityFile } from '../paths.ts';
import { readAffinityHolder } from '../transports/mailbox.ts';
import { log } from '../logger.ts';

/**
 * Recover dead-pid affinity sentinels.
 *
 * Scan ~/.crewmate/<agent>/affinity/ for every sentinel file, read its
 * holder pid (via readAffinityHolder), and:
 *   - if the pid is dead (process.kill(pid, 0) → ESRCH), unlink the
 *     sentinel so the next worker referencing that contextId can re-claim;
 *   - if the pid is alive (no error or EPERM), leave it alone — context
 *     is legitimately held by a running worker;
 *   - if the sentinel is corrupt / unreadable, skip with a warning log
 *     (don't auto-delete: an operator may want to inspect).
 *
 * Analogous to recoverOrphans in supervisor.ts (which handles dead-pid
 * task files in workers/<pid>/). This handles the affinity counterpart.
 *
 * Returns the count of sentinels recovered (i.e. unlinked).
 *
 * Called from supervisor startup and after every worker_died event.
 */
export async function recoverDeadAffinity(agentName: string): Promise<number> {
  const root = affinityRoot(agentName);
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }

  let recovered = 0;
  for (const name of entries) {
    // Sentinels are named exactly `<contextId>` (no extension). Skip
    // anything that obviously isn't one — including transient *.tmp.* files
    // left by a crashed atomic write.
    if (name.startsWith('.')) continue;
    if (name.includes('.tmp.')) continue;

    const contextId = name;
    let holderPid: number | null;
    try {
      holderPid = await readAffinityHolder(agentName, contextId);
    } catch (err) {
      log({
        event: 'affinity_recovery_skipped',
        agent: agentName,
        contextId,
        reason: 'unreadable sentinel',
        error: (err as Error).message,
      });
      continue;
    }

    if (holderPid === null) {
      // Either ENOENT (vanished) or corrupt-shape sentinel. readAffinityHolder
      // returns null in both cases. Leave on-disk corrupt files alone —
      // operators can inspect; auto-deleting would silently destroy state
      // we don't understand.
      continue;
    }

    let alive: boolean;
    try {
      process.kill(holderPid, 0);
      alive = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') alive = false;
      else if (code === 'EPERM') alive = true; // exists but not ours to signal
      else {
        log({
          event: 'affinity_recovery_skipped',
          agent: agentName,
          contextId,
          reason: 'liveness check failed',
          error: (err as Error).message,
        });
        continue;
      }
    }
    if (alive) continue;

    // Holder is dead. Unlink the sentinel atomically so a future task
    // referencing this contextId can re-claim affinity.
    const sentinelPath = affinityFile(agentName, contextId);
    try {
      await fs.unlink(sentinelPath);
      log({
        event: 'affinity_recovered',
        agent: agentName,
        contextId,
        orphanPid: holderPid,
      });
      recovered++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOENT is benign — someone else cleaned up between our read and
      // unlink. Don't count it, don't fail.
      if (code === 'ENOENT') continue;
      log({
        event: 'affinity_recovery_failed',
        agent: agentName,
        contextId,
        orphanPid: holderPid,
        error: (err as Error).message,
      });
    }
  }
  // Best-effort empty-dir cleanup is intentionally omitted. ensureContextsTree
  // expects the dir to exist; removing it would race with createContext.
  return recovered;
}
