import fs from 'node:fs/promises';
import path from 'node:path';
import chokidar from 'chokidar';
import {
  inboxDir,
  cancelDir,
  workerDir,
  workerTaskPath,
  processedTaskPath,
  cancelSentinelPath,
  stdoutLogPath,
  stderrLogPath,
  inboxTaskPath,
  affinityRoot,
  ensureAgentTree,
} from './paths.ts';
import {
  loadAgentCard,
  loadAgentConfig,
  readTaskRequest,
  writeTaskResult,
  tryClaim,
  quietUnlink,
  createContext,
  readContextMeta,
  appendContextTurn,
  readContextTurns,
  listContextIds,
  tryClaimAffinity,
  releaseAffinity,
  readAffinityHolder,
  ContextNotFoundError,
} from './transports/mailbox.ts';
import { runCli } from './runner.ts';
import { AcpRunner } from './transports/acp-runner.ts';
import { log, closeLogger } from './logger.ts';
import type { RunnerResult } from './types.ts';
import type {
  ContextTurn,
  TaskRequest,
  TaskResult,
  TaskStatus,
} from './envelope.ts';

/**
 * Child worker process.
 *
 * v1 lifecycle:
 *   1. mkdir its own workers/<pid>/ directory.
 *   2. Watch inbox/ via chokidar with awaitWriteFinish so we never see
 *      a half-written task file.
 *   3. On every "add" event (and on startup, for rehydration), atomically
 *      try to rename the inbox file into our private workers/<pid>/ dir.
 *      ENOENT = another worker won the race. We move on silently.
 *   4. Run the CLI via runner.ts. stdout/stderr are tee'd to per-task log files.
 *   5. Atomically write the result to outbox/.
 *   6. Move the claimed file to processed/.
 *
 * v1.1 additions:
 *   - **Pre-claim affinity peek** for envelopes that name a contextId. If a
 *     different live worker already holds the context, leave the file in
 *     inbox/ untouched so the holder can pick it up after release. We never
 *     log on every poll — only once per (taskId, holder) pair.
 *   - **Context-aware prompt construction**: for newContext we mint, enforce
 *     per-agent (50) and per-worker (10) caps, and stash a fresh ctx. For
 *     contextId we load meta + prior turns and concatenate them into the
 *     prompt with the spec-mandated "Turn N:" preface.
 *   - **Bloat warnings** at 50KB / 100KB / 200KB thresholds, once per
 *     (contextId, threshold) per worker process.
 *   - **Turn persistence**: append a ContextTurn after the CLI returns, then
 *     release affinity in `finally` and immediately re-scan inbox/ for the
 *     next queued turn of that context.
 *
 * Cancellation:
 *   A second chokidar watch on cancel/ — when cancel/<taskId> appears for a
 *   task we currently own (tracked in `inFlight`), abort the AbortController.
 *   The runner will SIGTERM the child, then SIGKILL after 2s.
 */

interface InFlightEntry {
  taskId: string;
  abort: AbortController;
  startedAt: number;
}

const AGENT = process.env.CREWMATE_AGENT;
if (!AGENT) {
  console.error('[worker] CREWMATE_AGENT env var is required');
  process.exit(2);
}
const AGENT_NAME: string = AGENT;

// Per-agent cap: max active contexts (excluding archived). Spec'd at 50.
const PER_AGENT_CONTEXT_CAP = 50;
// Per-worker cap: max contexts a single worker can hold affinity on. Spec'd at 10.
const PER_WORKER_CONTEXT_CAP = 10;
// Bloat-warning thresholds in bytes. Crossing any of these emits one stderr
// line per (contextId, threshold) per worker process lifetime.
const BLOAT_THRESHOLDS = [50_000, 100_000, 200_000] as const;

async function main(): Promise<void> {
  const pid = process.pid;
  const card = await loadAgentCard(AGENT_NAME);
  const config = await loadAgentConfig(AGENT_NAME);

  const isAcp = card.transport === 'acp' && card.acpCommand && card.acpCommand.length > 0;
  let acpRunner: AcpRunner | null = null;
  if (isAcp) {
    acpRunner = new AcpRunner(card);
    try {
      await acpRunner.ensureRunning();
      log({ event: 'acp_worker_ready', agent: AGENT_NAME, pid });
    } catch (err) {
      log({
        event: 'acp_worker_fallback',
        agent: AGENT_NAME,
        pid,
        error: (err as Error).message,
      });
      acpRunner = null;
    }
  }

  await ensureAgentTree(AGENT_NAME);
  await fs.mkdir(workerDir(AGENT_NAME, pid), { recursive: true });

  log({ event: 'worker_started', agent: AGENT_NAME, pid });

  const inFlight = new Map<string, InFlightEntry>();
  // Bloat-warning de-dupe: "<contextId>:<threshold>" → already warned.
  const warnedBloat = new Set<string>();
  // De-dupe "skipping task X — held by pid Y" stderr noise: a watcher fires
  // on every add and we may re-see the same file repeatedly during the brief
  // window before the holder picks it up.
  const seenSkip = new Set<string>(); // "<taskId>:<holderPid>"

  // ─── ACP fast-path task runner (closure over acpRunner, AGENT_NAME) ───────
  const runAcpTask = async (
    req: TaskRequest,
    taskId: string,
    ac: AbortController,
    startedAt: number,
    cfg: typeof config
  ): Promise<TaskResult> => {
    if (!acpRunner) {
      return {
        taskId,
        agent: AGENT_NAME,
        status: 'failed',
        summary: 'ACP runner not available',
        result: '',
        error: 'acpRunner is null',
        usage: { durationMs: Date.now() - startedAt, exitCode: null, stdoutBytes: 0 },
        completedAt: new Date().toISOString(),
      };
    }
    if (!acpRunner.alive) {
      try {
        await acpRunner.ensureRunning();
      } catch (err) {
        return {
          taskId,
          agent: AGENT_NAME,
          status: 'failed',
          summary: 'ACP process not available',
          result: '',
          error: (err as Error).message,
          usage: { durationMs: Date.now() - startedAt, exitCode: null, stdoutBytes: 0 },
          completedAt: new Date().toISOString(),
        };
      }
    }

    let sessionId: string;
    const isNewContext = req.newContext;
    const existingContextId = req.contextId;

    if (isNewContext || !existingContextId) {
      sessionId = await acpRunner.createSession({ cwd: req.context?.cwd });
    } else {
      sessionId = existingContextId;
    }

    const timeoutMs = req.timeoutMs ?? cfg.timeoutMs;
    const runRes = await acpRunner.sendMessage(sessionId, req.prompt, {
      timeoutMs,
      signal: ac.signal,
    });

    let status: TaskStatus = 'completed';
    let error: string | null = null;
    if (runRes.hint === 'aborted') {
      status = 'canceled';
      error = 'Canceled by cancel sentinel';
    } else if (runRes.hint === 'timeout') {
      status = 'timeout';
      error = `Exceeded timeoutMs=${timeoutMs}`;
    } else if (runRes.exitCode !== 0 && runRes.exitCode !== null) {
      status = 'failed';
      error = runRes.stderr.trim().slice(-500) || 'ACP request failed';
    }

    const session = acpRunner.getSession(sessionId);

    return {
      taskId,
      agent: AGENT_NAME,
      status,
      summary: summarize(runRes.stdout, status),
      result: runRes.stdout,
      error,
      usage: {
        durationMs: runRes.durationMs,
        exitCode: runRes.exitCode,
        stdoutBytes: Buffer.byteLength(runRes.stdout, 'utf8'),
      },
      completedAt: new Date().toISOString(),
      contextId: isNewContext ? sessionId : (existingContextId ?? null),
      turnNumber: session?.turnCount,
    };
  };

  // ─── inbox claim path ─────────────────────────────────────────────────────
  //
  // Order of operations:
  //   1. Read the task envelope (via readTaskRequest, which validates against
  //      the v1.1 zod schema). Treat ENOENT silently (another worker raced).
  //   2. v1 fast path: no contextId, no newContext → behave exactly as today.
  //   3. v1.1 path: peek at contextId. If `held-by-other`, leave the file in
  //      inbox/. Otherwise (acquired / held-by-self / not yet claimed because
  //      newContext) proceed to atomic-claim into workers/<pid>/.
  //
  // The "peek" must NOT release the affinity it just acquired — handleTask
  // owns that release (in `finally`). We pass the peek result downstream so
  // handleTask doesn't redundantly re-claim.
  const handleClaim = async (filePath: string): Promise<void> => {
    const base = path.basename(filePath);
    if (!base.endsWith('.task.json')) return;
    const taskId = base.slice(0, -'.task.json'.length);
    if (inFlight.has(taskId)) return;

    // Step 1: peek at the envelope. ENOENT = raced; let the winner handle it.
    let req: TaskRequest;
    try {
      req = await readTaskRequest(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      log({
        event: 'task_failed',
        agent: AGENT_NAME,
        pid,
        taskId,
        error: `envelope parse: ${(err as Error).message}`,
      });
      return;
    }

    // Step 2: v1 envelope (no contextId, no newContext) → fast path. Behave
    // exactly as v1.0: skip all affinity logic, claim directly.
    const wantsContext = req.newContext || req.contextId !== undefined;
    let preClaimedAffinity: 'acquired' | 'held-by-self' | null = null;

    // Step 3: v1.1 envelope with an existing contextId — peek at affinity.
    if (req.contextId !== undefined) {
      let result: 'acquired' | 'held-by-self' | 'held-by-other';
      try {
        result = await tryClaimAffinity(AGENT_NAME, req.contextId, pid);
      } catch (err) {
        log({
          event: 'task_failed',
          agent: AGENT_NAME,
          pid,
          taskId,
          contextId: req.contextId,
          error: `affinity peek: ${(err as Error).message}`,
        });
        return;
      }
      if (result === 'held-by-other') {
        const holder = await readAffinityHolder(AGENT_NAME, req.contextId);
        const key = `${taskId}:${holder ?? 'unknown'}`;
        if (!seenSkip.has(key)) {
          seenSkip.add(key);
          log({
            event: 'affinity_skipped',
            agent: AGENT_NAME,
            pid,
            taskId,
            contextId: req.contextId,
          });
        }
        return; // leave file in inbox; the holder (or recovery) will pick up
      }
      preClaimedAffinity = result;
    }

    // Step 4: atomic-rename into workers/<pid>/.
    const dest = workerTaskPath(AGENT_NAME, pid, taskId);
    let claimed = false;
    try {
      claimed = await tryClaim(filePath, dest);
    } catch (err) {
      log({
        event: 'task_failed',
        agent: AGENT_NAME,
        pid,
        taskId,
        error: `claim error: ${(err as Error).message}`,
      });
      // If we acquired the affinity sentinel just above and then lost the
      // inbox race, release the sentinel — otherwise we'd leak it.
      if (preClaimedAffinity === 'acquired' && req.contextId !== undefined) {
        await releaseAffinity(AGENT_NAME, req.contextId, pid).catch(() => {});
      }
      return;
    }
    if (!claimed) {
      // Lost the inbox race. Release any affinity we briefly acquired.
      if (preClaimedAffinity === 'acquired' && req.contextId !== undefined) {
        await releaseAffinity(AGENT_NAME, req.contextId, pid).catch(() => {});
      }
      return;
    }

    // From here on, the task is ours. Hand off.
    await handleTask(taskId, req, dest, wantsContext, preClaimedAffinity);
  };

  // ─── post-claim task handler ──────────────────────────────────────────────
  //
  // dest is the workers/<pid>/<taskId>.task.json that we already own.
  // preClaimedAffinity is non-null iff we already hold req.contextId's sentinel.
  const handleTask = async (
    taskId: string,
    req: TaskRequest,
    dest: string,
    wantsContext: boolean,
    preClaimedAffinity: 'acquired' | 'held-by-self' | null
  ): Promise<void> => {
    const ac = new AbortController();
    const startedAt = Date.now();
    inFlight.set(taskId, { taskId, abort: ac, startedAt });

    log({ event: 'task_claimed', agent: AGENT_NAME, pid, taskId });

    // Resolved contextId (filled in by either newContext mint or req.contextId).
    let resolvedContextId: string | null = null;
    // Whether *we* hold affinity (and thus must release in finally).
    let holdsAffinity = false;
    let result: TaskResult;
    let archiveAfter = true;

    try {
      // ─── v1 fast path: no context wanted ───────────────────────────────
      if (!wantsContext) {
        if (acpRunner) {
          result = await runAcpTask(req, taskId, ac, startedAt, config);
        } else {
          result = await runFreshContextTask(card, req, taskId, ac, startedAt, config);
        }
        return; // result is written below in finally
      }

      // ─── v1.1 path: resolve a contextId ────────────────────────────────
      if (req.newContext) {
        // Per-agent cap.
        const active = await listContextIds(AGENT_NAME);
        if (active.length >= PER_AGENT_CONTEXT_CAP) {
          log({
            event: 'context_full',
            agent: AGENT_NAME,
            capacity: PER_AGENT_CONTEXT_CAP,
            currentCount: active.length,
          });
          result = buildFailedResult(taskId, startedAt, {
            error: 'pool_context_full',
            summary: 'context cap reached',
          });
          return;
        }
        // Per-worker cap. Walk affinity/ once and count holders == us.
        const ourHeld = await countHeldByPid(AGENT_NAME, pid);
        if (ourHeld >= PER_WORKER_CONTEXT_CAP) {
          log({
            event: 'context_full',
            agent: AGENT_NAME,
            pid,
            capacity: PER_WORKER_CONTEXT_CAP,
            currentCount: ourHeld,
          });
          result = buildFailedResult(taskId, startedAt, {
            error: 'pool_context_full',
            summary: 'context cap reached',
          });
          return;
        }
        // Mint. v1.1: forward optional ttlMs from envelope so Bash --ttl-ms
        // and MCP newContext.ttlMs both reach the storage layer identically.
        const meta = await createContext(AGENT_NAME, {
          ownerHint: req.ownerHint,
          ttlMs: req.ttlMs,
        });
        resolvedContextId = meta.contextId;
        log({
          event: 'context_minted',
          agent: AGENT_NAME,
          pid,
          contextId: resolvedContextId,
          ownerHint: req.ownerHint,
        });
      } else if (req.contextId !== undefined) {
        // Continuation: validate the context exists.
        try {
          await readContextMeta(AGENT_NAME, req.contextId);
        } catch (err) {
          if (err instanceof ContextNotFoundError) {
            log({
              event: 'task_failed',
              agent: AGENT_NAME,
              pid,
              taskId,
              contextId: req.contextId,
              error: 'context_not_found',
            });
            result = buildFailedResult(taskId, startedAt, {
              error: 'context_not_found',
              summary: `context not found: ${req.contextId}`,
            });
            // We may have pre-claimed affinity on a context that doesn't
            // exist (peek succeeded because affinity is keyed only by name).
            // Release it so we don't leak.
            if (preClaimedAffinity === 'acquired') {
              await releaseAffinity(AGENT_NAME, req.contextId, pid).catch(
                () => {}
              );
            }
            return;
          }
          throw err;
        }
        resolvedContextId = req.contextId;
      }

      if (resolvedContextId === null) {
        // Shouldn't happen — wantsContext true but neither branch hit. Fail loud.
        result = buildFailedResult(taskId, startedAt, {
          error: 'internal_error',
          summary: 'context resolution failed',
        });
        return;
      }

      // Affinity claim. For newContext (just minted) we always need a fresh
      // claim. For continuation we may have one from the peek already.
      if (preClaimedAffinity !== null && req.contextId === resolvedContextId) {
        holdsAffinity = true;
      } else {
        const claimResult = await tryClaimAffinity(
          AGENT_NAME,
          resolvedContextId,
          pid
        );
        if (claimResult === 'held-by-other') {
          // Race: between mint and claim someone else claimed (impossible for
          // freshly-minted IDs in practice, but defensive). For continuations
          // re-thread the task back to inbox so the holder can pick it up.
          log({
            event: 'affinity_skipped',
            agent: AGENT_NAME,
            pid,
            taskId,
            contextId: resolvedContextId,
            reason: 'race_after_resolve',
          });
          // Move the file back to inbox so another worker re-scans it.
          const back = inboxTaskPath(AGENT_NAME, taskId);
          try {
            await fs.rename(dest, back);
            archiveAfter = false; // it's no longer ours to archive
          } catch (err) {
            log({
              event: 'task_failed',
              agent: AGENT_NAME,
              pid,
              taskId,
              error: `requeue after affinity race: ${(err as Error).message}`,
            });
          }
          // Bail out without writing a result; another worker will produce one.
          inFlight.delete(taskId);
          return;
        }
        holdsAffinity = true;
      }

      // Read prior turns (may be 0 if newContext or stale meta).
      let priorTurns: ContextTurn[] = [];
      try {
        priorTurns = await readContextTurns(AGENT_NAME, resolvedContextId);
      } catch (err) {
        if (!(err instanceof ContextNotFoundError)) throw err;
        // newContext path: createContext made the dir but readContextTurns
        // is tolerant; we shouldn't hit this. If we do, treat as 0 turns.
      }

      // Build the constructed prompt.
      const constructedPrompt = buildPrompt(priorTurns, req.prompt);
      const promptBytes = Buffer.byteLength(constructedPrompt, 'utf8');
      const turnNumber = priorTurns.length + 1;

      // Bloat warnings — emit once per (contextId, threshold) per worker.
      for (const t of BLOAT_THRESHOLDS) {
        if (promptBytes < t) continue;
        const key = `${resolvedContextId}:${t}`;
        if (warnedBloat.has(key)) continue;
        warnedBloat.add(key);
        const kb = Math.round(promptBytes / 1024);
        const tokens = Math.round(promptBytes / 4 / 1000);
        process.stderr.write(
          `[crewmate] context ${resolvedContextId} turn ${turnNumber} — ` +
            `prompt now ${kb}KB / ~${tokens}K tokens — consider mint new context\n`
        );
      }

      log({
        event: 'context_used',
        agent: AGENT_NAME,
        pid,
        contextId: resolvedContextId,
        taskId,
        turnNumber,
        promptBytes,
      });

      // Run the CLI.
      const timeoutMs = req.timeoutMs ?? config.timeoutMs;
      const cwd = req.context?.cwd;
      let runRes: RunnerResult;
      if (acpRunner) {
        let acpSessionId: string;
        if (req.newContext || !resolvedContextId) {
          acpSessionId = await acpRunner.createSession({ cwd });
        } else {
          acpSessionId = resolvedContextId;
        }
        runRes = await acpRunner.sendMessage(acpSessionId, req.prompt, {
          timeoutMs,
          signal: ac.signal,
        });
      } else {
        runRes = await runCli(card, constructedPrompt, {
          cwd,
          timeoutMs,
          signal: ac.signal,
          stdoutLogPath: stdoutLogPath(AGENT_NAME, taskId),
          stderrLogPath: stderrLogPath(AGENT_NAME, taskId),
        });
      }

      let status: TaskStatus = 'completed';
      let error: string | null = null;
      if (runRes.hint === 'aborted') {
        status = 'canceled';
        error = 'Canceled by cancel sentinel';
      } else if (runRes.hint === 'timeout') {
        status = 'timeout';
        error = `Exceeded timeoutMs=${timeoutMs}`;
      } else if (runRes.exitCode !== 0) {
        status = 'failed';
        error =
          runRes.stderr.trim().slice(-500) ||
          `Process exited with code ${runRes.exitCode}`;
      }

      // Persist the turn — only if the CLI actually completed (regardless of
      // exit code). For canceled/timeout we still persist; the failed turn is
      // useful history. Skip on internal exceptions (caught below).
      let persistedTurn: number | undefined;
      try {
        persistedTurn = await appendContextTurn(
          AGENT_NAME,
          resolvedContextId,
          {
            taskId: req.taskId,
            // Persist the ORIGINAL user prompt, not the concatenated form —
            // otherwise next turn's read would re-include prior turns and
            // explode quadratically.
            prompt: req.prompt,
            response: runRes.stdout,
            usage: {
              durationMs: runRes.durationMs,
              exitCode: runRes.exitCode,
              stdoutBytes: Buffer.byteLength(runRes.stdout, 'utf8'),
            },
            timestamp: new Date().toISOString(),
          }
        );
      } catch (writeErr) {
        log({
          event: 'task_failed',
          agent: AGENT_NAME,
          pid,
          taskId,
          contextId: resolvedContextId,
          error: `context_write_failed: ${(writeErr as Error).message}`,
        });
        result = buildFailedResult(taskId, startedAt, {
          error: 'context_write_failed',
          summary: 'turn persistence failed',
        });
        return;
      }

      result = {
        taskId,
        agent: AGENT_NAME,
        status,
        summary: summarize(runRes.stdout, status),
        result: runRes.stdout,
        error,
        usage: {
          durationMs: runRes.durationMs,
          exitCode: runRes.exitCode,
          stdoutBytes: Buffer.byteLength(runRes.stdout, 'utf8'),
        },
        completedAt: new Date().toISOString(),
        contextId: resolvedContextId,
        turnNumber: persistedTurn,
      };
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      result = {
        taskId,
        agent: AGENT_NAME,
        status: 'failed',
        summary: 'Worker exception',
        result: '',
        error: message,
        usage: {
          durationMs: Date.now() - startedAt,
          exitCode: null,
          stdoutBytes: 0,
        },
        completedAt: new Date().toISOString(),
        contextId: resolvedContextId,
      };
    } finally {
      inFlight.delete(taskId);

      // Write result — only if we still hold the task (archiveAfter=true).
      // The race-back-to-inbox path skips this entirely.
      if (archiveAfter) {
        // result is set in every reachable path that sets archiveAfter=true
        // (including all early-return failure branches above).
        try {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- result set in every archiveAfter=true path
          await writeTaskResult(AGENT_NAME, result!);
        } catch (err) {
          log({
            event: 'task_failed',
            agent: AGENT_NAME,
            pid,
            taskId,
            error: `result write failed: ${(err as Error).message}`,
          });
        }

        // Move claimed file → processed/.
        try {
          await fs.rename(dest, processedTaskPath(AGENT_NAME, taskId));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            log({
              event: 'task_failed',
              agent: AGENT_NAME,
              pid,
              taskId,
              error: `archive failed: ${(err as Error).message}`,
            });
          }
        }

        await quietUnlink(cancelSentinelPath(AGENT_NAME, taskId));

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- same as above
        const r = result!;
        log({
          event:
            r.status === 'completed'
              ? 'task_completed'
              : r.status === 'canceled'
                ? 'task_canceled'
                : r.status === 'timeout'
                  ? 'task_timeout'
                  : 'task_failed',
          agent: AGENT_NAME,
          pid,
          taskId,
          status: r.status,
          contextId: r.contextId ?? undefined,
          turnNumber: r.turnNumber,
          durationMs: r.usage.durationMs,
          exitCode: r.usage.exitCode,
        });
      }

      // Release affinity (idempotent — only succeeds if we hold it).
      if (holdsAffinity && resolvedContextId !== null) {
        const reason =
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- holdsAffinity implies result was set
          result! && result!.status === 'completed'
            ? 'task_complete'
            : 'task_failed';
        await releaseAffinity(AGENT_NAME, resolvedContextId, pid).catch(
          () => {}
        );
        log({
          event: 'affinity_released',
          agent: AGENT_NAME,
          pid,
          contextId: resolvedContextId,
          reason,
        });
        // Re-scan inbox for queued tasks targeting the just-released context.
        // Fire and forget — errors here don't fail the just-finished task.
        void scanInboxForContext(resolvedContextId).catch((err) => {
          log({
            event: 'task_failed',
            agent: AGENT_NAME,
            pid,
            error: `inbox rescan: ${(err as Error).message}`,
          });
        });
      }
    }
  };

  // ─── v1 fresh-context fast path ──────────────────────────────────────────
  //
  // No context. No affinity. Mirrors the v1.0 worker behavior exactly.
  // Returns a TaskResult; outer finally writes it.
  const runFreshContextTask = async (
    cardLocal: typeof card,
    req: TaskRequest,
    taskId: string,
    ac: AbortController,
    startedAt: number,
    cfg: typeof config
  ): Promise<TaskResult> => {
    const timeoutMs = req.timeoutMs ?? cfg.timeoutMs;
    const cwd = req.context?.cwd;
    const runRes = await runCli(cardLocal, req.prompt, {
      cwd,
      timeoutMs,
      signal: ac.signal,
      stdoutLogPath: stdoutLogPath(AGENT_NAME, taskId),
      stderrLogPath: stderrLogPath(AGENT_NAME, taskId),
    });

    let status: TaskStatus = 'completed';
    let error: string | null = null;
    if (runRes.hint === 'aborted') {
      status = 'canceled';
      error = 'Canceled by cancel sentinel';
    } else if (runRes.hint === 'timeout') {
      status = 'timeout';
      error = `Exceeded timeoutMs=${timeoutMs}`;
    } else if (runRes.exitCode !== 0) {
      status = 'failed';
      error =
        runRes.stderr.trim().slice(-500) ||
        `Process exited with code ${runRes.exitCode}`;
    }

    return {
      taskId,
      agent: AGENT_NAME,
      status,
      summary: summarize(runRes.stdout, status),
      result: runRes.stdout,
      error,
      usage: {
        durationMs: runRes.durationMs,
        exitCode: runRes.exitCode,
        stdoutBytes: Buffer.byteLength(runRes.stdout, 'utf8'),
      },
      completedAt: new Date().toISOString(),
    };
  };

  // ─── inbox re-scan for a specific context ─────────────────────────────────
  //
  // Called after release_affinity. Walks inbox/ once looking for any task
  // whose envelope contextId matches the just-released id, and feeds it back
  // through handleClaim. Cheap because we already opened readdir + readJson
  // for the small subset that matters.
  const scanInboxForContext = async (contextId: string): Promise<void> => {
    const dir = inboxDir(AGENT_NAME);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const name of entries) {
      if (!name.endsWith('.task.json')) continue;
      const filePath = path.join(dir, name);
      // Quick peek without parsing the full envelope through zod — we just
      // need the contextId field. But we already have readTaskRequest; the
      // cost is negligible vs. the affinity logic in handleClaim.
      let req: TaskRequest;
      try {
        req = await readTaskRequest(filePath);
      } catch {
        // Could be a partially-written file or unrelated; skip.
        continue;
      }
      if (req.contextId !== contextId) continue;
      // Defer to the standard claim path — re-uses the affinity peek.
      void handleClaim(filePath);
    }
  };

  const handleCancel = (filePath: string): void => {
    const taskId = path.basename(filePath);
    const entry = inFlight.get(taskId);
    if (!entry) return; // not ours; another worker (or no worker) owns this id
    log({ event: 'task_canceled', agent: AGENT_NAME, pid, taskId, reason: 'cancel sentinel' });
    entry.abort.abort();
  };

  // Inbox watcher: claim new tasks
  const inboxWatcher = chokidar.watch(inboxDir(AGENT_NAME), {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    depth: 0,
  });
  inboxWatcher.on('add', (p) => {
    void handleClaim(p);
  });

  // Cancel watcher: abort in-flight tasks
  const cancelWatcher = chokidar.watch(cancelDir(AGENT_NAME), {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 25, pollInterval: 25 },
    depth: 0,
  });
  cancelWatcher.on('add', (p) => handleCancel(p));

  // Graceful shutdown
  const shutdown = async (sig: string): Promise<void> => {
    log({ event: 'worker_died', agent: AGENT_NAME, pid, reason: sig });
    for (const entry of inFlight.values()) entry.abort.abort();
    await Promise.allSettled([inboxWatcher.close(), cancelWatcher.close()]);
    if (acpRunner) {
      await acpRunner.shutdown();
    }
    await closeLogger();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

/** Heuristic one-line summary of stdout, mirroring Claude Code's <task-notification summary>. */
function summarize(stdout: string, status: TaskStatus): string {
  if (status !== 'completed') {
    return `Task ${status}`;
  }
  const trimmed = stdout.trim();
  if (!trimmed) return 'Task completed (no stdout)';
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? '';
  return firstLine.length > 200 ? firstLine.slice(0, 197) + '...' : firstLine;
}

/**
 * Build the concatenated prompt for a context-aware task.
 *
 * Spec format:
 *   This is turn N of a continuing conversation. Prior turns:
 *
 *   Turn 1:
 *   User: <prompt_1>
 *   You: <response_1>
 *
 *   ...
 *
 *   Current turn:
 *   User: <new_prompt>
 *
 * If priorTurns is empty (newContext path or stale meta with turnCount=0):
 *   Current turn:
 *   User: <new_prompt>
 */
function buildPrompt(priorTurns: ContextTurn[], newPrompt: string): string {
  if (priorTurns.length === 0) {
    return `Current turn:\nUser: ${newPrompt}`;
  }
  const N = priorTurns.length + 1;
  const lines: string[] = [];
  lines.push(`This is turn ${N} of a continuing conversation. Prior turns:`);
  lines.push('');
  for (let i = 0; i < priorTurns.length; i++) {
    const turn = priorTurns[i]!;
    lines.push(`Turn ${i + 1}:`);
    lines.push(`User: ${turn.prompt}`);
    lines.push(`You: ${turn.response}`);
    lines.push('');
  }
  lines.push('Current turn:');
  lines.push(`User: ${newPrompt}`);
  return lines.join('\n');
}

/**
 * Build a TaskResult representing a worker-side failure (cap exceeded,
 * context not found, persistence failed). Common shape for v1.1 failure
 * envelopes that the spec mandates.
 */
function buildFailedResult(
  taskId: string,
  startedAt: number,
  opts: { error: string; summary: string }
): TaskResult {
  return {
    taskId,
    agent: AGENT_NAME,
    status: 'failed',
    summary: opts.summary,
    result: '',
    error: opts.error,
    usage: {
      durationMs: Date.now() - startedAt,
      exitCode: null,
      stdoutBytes: 0,
    },
    completedAt: new Date().toISOString(),
    contextId: null,
  };
}

/**
 * Count how many affinity sentinels are currently held by `pid`. Used for
 * the per-worker context cap. O(active contexts) with a readdir+readJson per
 * file — cheap because the cap is 10 and the cap check happens only at mint
 * time. Not racy: the count reflects an instantaneous snapshot, and a
 * concurrent claim from this worker would only widen the gap by 1.
 */
async function countHeldByPid(agent: string, pid: number): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(affinityRoot(agent));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  let held = 0;
  for (const name of entries) {
    // affinity files are bare contextIds (no extension); skip stray tmp files.
    if (name.includes('.tmp.')) continue;
    try {
      const holder = await readAffinityHolder(agent, name);
      if (holder === pid) held++;
    } catch {
      // best-effort count; skip unreadable
    }
  }
  return held;
}

main().catch((err) => {
  log({
    event: 'worker_died',
    agent: AGENT_NAME,
    pid: process.pid,
    error: (err as Error).message,
  });
  console.error('[worker] fatal:', err);
  process.exit(1);
});
