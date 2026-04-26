import fs from 'node:fs/promises';
import path from 'node:path';
import {
  agentCardFile,
  agentConfigFile,
  inboxTaskPath,
  outboxResultPath,
  cancelSentinelPath,
  contextDir,
  contextMetaFile,
  contextTurnFile,
  contextsRoot,
  archivedContextDir,
  archivedContextsRoot,
  affinityFile,
  ensureContextsTree,
} from '../paths.ts';
import {
  AgentCard,
  AgentConfig,
  ContextMeta,
  ContextTurn,
  TaskRequest,
  TaskResult,
} from '../envelope.ts';
import type {
  AgentCard as AgentCardT,
  AgentConfig as AgentConfigT,
  ContextMeta as ContextMetaT,
  ContextTurn as ContextTurnT,
  TaskRequest as TaskRequestT,
  TaskRequestInput,
  TaskResult as TaskResultT,
} from '../envelope.ts';
import { mintContextId } from '../util/context-id.ts';

/**
 * Filesystem mailbox helpers shared by `send`, `worker`, `cancel`, etc.
 *
 * Every write that another process might race against goes through
 * writeJsonAtomic — write to "<dest>.tmp", then rename. POSIX rename is
 * atomic within a filesystem, so readers either see the old file, the new
 * file, or ENOENT — never a half-written one.
 */

export async function writeJsonAtomic(
  destPath: string,
  payload: unknown
): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, destPath);
}

export async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

export async function loadAgentCard(name: string): Promise<AgentCardT> {
  const raw = await readJson<unknown>(agentCardFile(name));
  return AgentCard.parse(raw);
}

export async function loadAgentConfig(name: string): Promise<AgentConfigT> {
  try {
    const raw = await readJson<unknown>(agentConfigFile(name));
    return AgentConfig.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return AgentConfig.parse({});
    }
    throw err;
  }
}

export async function writeTaskRequest(
  agent: string,
  task: TaskRequestInput
): Promise<string> {
  // Parse fills defaults (version=1, newContext=false) so on-disk envelopes
  // are always fully populated — even when the caller only set v1.0 fields.
  const validated = TaskRequest.parse(task);
  const dest = inboxTaskPath(agent, validated.taskId);
  await writeJsonAtomic(dest, validated);
  return dest;
}

export async function writeTaskResult(
  agent: string,
  result: TaskResultT
): Promise<string> {
  const validated = TaskResult.parse(result);
  const dest = outboxResultPath(agent, validated.taskId);
  await writeJsonAtomic(dest, validated);
  return dest;
}

export async function readTaskRequest(filePath: string): Promise<TaskRequestT> {
  const raw = await readJson<unknown>(filePath);
  return TaskRequest.parse(raw);
}

export async function readTaskResult(filePath: string): Promise<TaskResultT> {
  const raw = await readJson<unknown>(filePath);
  return TaskResult.parse(raw);
}

export async function writeCancelSentinel(
  agent: string,
  taskId: string
): Promise<string> {
  const dest = cancelSentinelPath(agent, taskId);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  // Empty file is the signal; existence is what matters
  const fh = await fs.open(dest, 'w');
  await fh.close();
  return dest;
}

/**
 * Atomically attempt to claim a task by renaming it out of the shared inbox
 * into a worker-private dir. Returns true on success, false if another
 * worker beat us to it (ENOENT). Other errors propagate.
 */
export async function tryClaim(
  fromInboxPath: string,
  toWorkerPath: string
): Promise<boolean> {
  await fs.mkdir(path.dirname(toWorkerPath), { recursive: true });
  try {
    await fs.rename(fromInboxPath, toWorkerPath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw err;
  }
}

/** Best-effort delete; swallows ENOENT. Used for cancel sentinels and tmp files. */
export async function quietUnlink(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

// ─── v1.1 context storage ────────────────────────────────────────────────────
//
// All writes are atomic (writeJsonAtomic = tmp+rename). All reads validate
// against the zod schema. ENOENT on a meta read becomes ContextNotFoundError
// so callers can distinguish "you asked for a nonexistent context" from
// "the disk is broken."

export class ContextNotFoundError extends Error {
  constructor(public readonly agent: string, public readonly contextId: string) {
    super(`context not found: ${agent}/${contextId}`);
    this.name = 'ContextNotFoundError';
  }
}

/**
 * Best-effort recursive remove. Used to roll back partial writes — failures
 * here cannot themselves be recovered, so we surface them via the caller.
 */
async function rmIfExists(p: string): Promise<void> {
  try {
    await fs.rm(p, { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** Mints contextId if not given; writes meta.json atomically; returns the meta. */
export async function createContext(
  agent: string,
  opts: { contextId?: string; ownerHint?: string; ttlMs?: number } = {}
): Promise<ContextMetaT> {
  await ensureContextsTree(agent);
  const contextId = opts.contextId ?? mintContextId();
  const now = new Date().toISOString();

  // Build the meta object explicitly so zod's defaults populate predictably.
  // We pass ttlMs through `parse` rather than a manual default to keep one
  // source of truth for the default value (envelope.ts).
  const meta = ContextMeta.parse({
    contextId,
    agent,
    created: now,
    lastUsed: now,
    ownerHint: opts.ownerHint,
    turnCount: 0,
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
  });

  // mkdir before writing meta so writeJsonAtomic's rename has a target dir.
  await fs.mkdir(contextDir(agent, contextId), { recursive: true });
  await writeJsonAtomic(contextMetaFile(agent, contextId), meta);
  return meta;
}

export async function readContextMeta(
  agent: string,
  contextId: string
): Promise<ContextMetaT> {
  try {
    const raw = await readJson<unknown>(contextMetaFile(agent, contextId));
    return ContextMeta.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ContextNotFoundError(agent, contextId);
    }
    throw err;
  }
}

export async function writeContextMeta(
  agent: string,
  contextId: string,
  meta: ContextMetaT
): Promise<void> {
  const validated = ContextMeta.parse(meta);
  await writeJsonAtomic(contextMetaFile(agent, contextId), validated);
}

/**
 * Append a turn to a context.
 *
 * Sequence (read-modify-write on meta.json):
 *   1. read meta
 *   2. assign turnNumber = meta.turnCount + 1
 *   3. write turn_NNN.json atomically
 *   4. write updated meta.json atomically (turnCount++, lastUsed=now)
 *   5. on meta-write failure: roll back the turn file
 *
 * Concurrency note: multiple writers on the same context will race on step 4
 * and one will overwrite the other's turn count. The spec says affinity
 * routing (Step 4) ensures only one worker writes a given context at a time,
 * so we don't need cross-process locking here. If that invariant ever breaks
 * we'll need an O_EXCL "next turn" reservation file — out of scope for now.
 */
export async function appendContextTurn(
  agent: string,
  contextId: string,
  turn: ContextTurnT
): Promise<number> {
  const validatedTurn = ContextTurn.parse(turn);
  const meta = await readContextMeta(agent, contextId);
  const turnNumber = meta.turnCount + 1;
  const turnPath = contextTurnFile(agent, contextId, turnNumber);

  // Step 3: write the turn file first. If this fails, meta is untouched.
  await writeJsonAtomic(turnPath, validatedTurn);

  // Step 4: update meta. On failure, roll back the turn file.
  const nextMeta: ContextMetaT = {
    ...meta,
    turnCount: turnNumber,
    lastUsed: new Date().toISOString(),
  };
  try {
    await writeContextMeta(agent, contextId, nextMeta);
  } catch (metaErr) {
    try {
      await quietUnlink(turnPath);
    } catch (rollbackErr) {
      // Both writes failed. Surface a combined error so the caller can log
      // a task_requeue_failed-style event upstream.
      const re = rollbackErr as Error;
      const me = metaErr as Error;
      throw new Error(
        `appendContextTurn: meta write failed AND rollback failed for ` +
          `${agent}/${contextId} turn ${turnNumber}. ` +
          `meta error: ${me.message}; rollback error: ${re.message}`
      );
    }
    throw metaErr;
  }

  return turnNumber;
}

/**
 * Read all turns for a context, sorted by turnNumber.
 *
 * Tolerant: skips *.tmp files (writeJsonAtomic leftovers from a crash) and
 * gaps in the numbering (logs a warning, returns the contiguous prefix it
 * could parse). Throws ContextNotFoundError if the context dir is missing.
 */
export async function readContextTurns(
  agent: string,
  contextId: string
): Promise<ContextTurnT[]> {
  const dir = contextDir(agent, contextId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ContextNotFoundError(agent, contextId);
    }
    throw err;
  }

  const turnFileRegex = /^turn_(\d{3})\.json$/;
  const numbered: { n: number; file: string }[] = [];
  for (const name of entries) {
    const m = turnFileRegex.exec(name);
    if (!m) continue; // skips meta.json, *.tmp.*, and anything else
    numbered.push({ n: parseInt(m[1]!, 10), file: name });
  }
  numbered.sort((a, b) => a.n - b.n);

  // Detect gaps and log a warning (continue with what we have — readers
  // shouldn't fail because one historical turn vanished).
  let expected = 1;
  for (const { n } of numbered) {
    if (n !== expected) {
      // eslint-disable-next-line no-console -- intentional: warn, not throw
      console.warn(
        `readContextTurns: gap detected in ${agent}/${contextId} ` +
          `(expected turn ${expected}, found ${n}); continuing`
      );
      // Don't bump expected past the gap; subsequent gaps would re-warn.
      // Use the actual n so we keep marching forward.
    }
    expected = n + 1;
  }

  const turns: ContextTurnT[] = [];
  for (const { file } of numbered) {
    const raw = await readJson<unknown>(path.join(dir, file));
    turns.push(ContextTurn.parse(raw));
  }
  return turns;
}

/** List active context IDs (excludes .archived/). */
export async function listContextIds(agent: string): Promise<string[]> {
  const root = contextsRoot(agent);
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

/**
 * Move contexts/<id>/ to contexts/.archived/<id>/. Single rename = atomic
 * within the filesystem. The `reason` is currently advisory — Step 5's
 * lifecycle logger will read it for telemetry; we don't persist it on disk
 * (the caller is expected to log it separately).
 */
export async function archiveContext(
  agent: string,
  contextId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for caller-side logging contract
  reason: 'ttl' | 'explicit' | 'agent_purge'
): Promise<void> {
  await fs.mkdir(archivedContextsRoot(agent), { recursive: true });
  const src = contextDir(agent, contextId);
  const dst = archivedContextDir(agent, contextId);
  try {
    await fs.rename(src, dst);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ContextNotFoundError(agent, contextId);
    throw err;
  }
  // Best-effort: if a stale affinity sentinel exists, drop it. The context
  // is gone; nobody can hold it anymore.
  await quietUnlink(affinityFile(agent, contextId));
}

/**
 * Delete archived contexts whose lastUsed is older than (now - cutoffMs).
 * Returns the number purged.
 */
export async function purgeArchivedOlderThan(
  agent: string,
  cutoffMs: number
): Promise<number> {
  const root = archivedContextsRoot(agent);
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }

  const now = Date.now();
  let purged = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const metaPath = path.join(root, e.name, 'meta.json');
    let meta: ContextMetaT;
    try {
      const raw = await readJson<unknown>(metaPath);
      meta = ContextMeta.parse(raw);
    } catch (err) {
      // Corrupt or missing meta in an archived context — purge it. There's
      // no useful information to preserve and leaving it would block sweeps.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await rmIfExists(path.join(root, e.name));
        purged++;
      }
      // Schema-validation errors fall through; safer to skip than nuke
      // potentially-valuable data we just can't parse right now.
      continue;
    }
    const age = now - new Date(meta.lastUsed).getTime();
    if (age >= cutoffMs) {
      await rmIfExists(path.join(root, e.name));
      purged++;
    }
  }
  return purged;
}

// ─── Affinity claims ─────────────────────────────────────────────────────────
//
// affinity/<contextId> is a small JSON file: { workerPid, claimedAt }.
// Created with O_EXCL ('wx' flag) so two workers racing for the same
// context can never both succeed. Liveness check uses kill(pid, 0):
//   ESRCH → dead → safe to steal
//   EPERM → alive but not ours → held-by-other
//   no error → alive (and could be ours or someone else's)

interface AffinityRecord {
  workerPid: number;
  claimedAt: string;
}

function isAffinityRecord(v: unknown): v is AffinityRecord {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.workerPid === 'number' && typeof o.claimedAt === 'string';
}

/** Returns true if `pid` is currently a live process. */
function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 = "check if you can signal", doesn't actually deliver one.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true; // exists, just not ours to signal
    throw err;
  }
}

/**
 * Atomically write `record` to `dest` using O_EXCL semantics — fails fast
 * if the file already exists. Caller must handle EEXIST.
 */
async function writeJsonExclusive(
  dest: string,
  record: AffinityRecord
): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  // 'wx' = O_WRONLY | O_CREAT | O_EXCL — atomic create-or-fail.
  const fh = await fs.open(dest, 'wx');
  try {
    await fh.writeFile(JSON.stringify(record, null, 2) + '\n', 'utf8');
  } finally {
    await fh.close();
  }
}

/**
 * Try to claim the affinity sentinel for `contextId`.
 *   'acquired'       — sentinel didn't exist (or held a dead pid we replaced)
 *   'held-by-self'   — sentinel exists and names workerPid
 *   'held-by-other'  — sentinel exists, names a different live pid
 *
 * Race-safe via fs.open(path, 'wx'). Replacement of a dead-pid sentinel
 * goes through tmp+rename so we never have a window where the file is
 * absent (other workers can race in if it is).
 */
export async function tryClaimAffinity(
  agent: string,
  contextId: string,
  workerPid: number
): Promise<'acquired' | 'held-by-other' | 'held-by-self'> {
  const dest = affinityFile(agent, contextId);
  const record: AffinityRecord = {
    workerPid,
    claimedAt: new Date().toISOString(),
  };

  // Fast path: try to create the file exclusively.
  try {
    await writeJsonExclusive(dest, record);
    return 'acquired';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // Fall through to the slow path.
  }

  // Slow path: file exists. Read it, decide what to do.
  let existing: AffinityRecord;
  try {
    const raw = await readJson<unknown>(dest);
    if (!isAffinityRecord(raw)) {
      // Corrupt sentinel. Treat as held-by-other rather than nuking it —
      // a manually-edited file shouldn't cause a workers stampede.
      return 'held-by-other';
    }
    existing = raw;
  } catch (err) {
    // ENOENT means the holder vanished between our 'wx' attempt and now.
    // Recurse once to retry; the next 'wx' attempt should succeed.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return tryClaimAffinity(agent, contextId, workerPid);
    }
    throw err;
  }

  if (existing.workerPid === workerPid) return 'held-by-self';

  if (isPidAlive(existing.workerPid)) return 'held-by-other';

  // Holder is dead. Replace atomically via tmp+rename. rename() over an
  // existing file is atomic on POSIX, so a concurrent reader sees either
  // the old (dead) record or our new one — never an empty/half file.
  const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
  try {
    await fs.rename(tmp, dest);
  } catch (renameErr) {
    // Best effort cleanup; surface the original error.
    await quietUnlink(tmp);
    throw renameErr;
  }
  return 'acquired';
}

/**
 * Release affinity if and only if we still own it. Idempotent — releasing
 * a sentinel we don't hold (or one that doesn't exist) is a no-op.
 */
export async function releaseAffinity(
  agent: string,
  contextId: string,
  workerPid: number
): Promise<void> {
  const dest = affinityFile(agent, contextId);
  let raw: unknown;
  try {
    raw = await readJson<unknown>(dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (!isAffinityRecord(raw)) {
    // Corrupt sentinel — leave it. Operator can clean up; we won't blow
    // away state we didn't write.
    return;
  }
  if (raw.workerPid !== workerPid) return; // not ours
  await quietUnlink(dest);
}

/** Read the pid currently holding the affinity sentinel, or null if none. */
export async function readAffinityHolder(
  agent: string,
  contextId: string
): Promise<number | null> {
  const dest = affinityFile(agent, contextId);
  try {
    const raw = await readJson<unknown>(dest);
    if (!isAffinityRecord(raw)) return null;
    return raw.workerPid;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

