import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import {
  ensureAgentTree,
  outboxResultPath,
  workersDir,
  homeDir,
  stdoutLogPath,
  stderrLogPath,
  progressLogPath,
} from '../paths.ts';
import { writeTaskRequest, readTaskResult } from '../transports/mailbox.ts';
import { log } from '../logger.ts';
import type { TaskRequestInput } from '../envelope.ts';

interface SendOptions {
  timeoutMs: number;
  cwd?: string;
  /** Continue an existing conversation. Mutually exclusive with newContext. */
  contextId?: string;
  /** Mint a fresh context for this task; result returns the new contextId. */
  newContext?: boolean;
  /**
   * Free-form label stored on meta.json — only consulted when minting a fresh
   * context (i.e. when newContext is true). If passed without --new-context
   * the worker silently ignores it; we don't error on the CLI either, since
   * zod would just store it harmlessly. We document this inline rather than
   * second-guessing the user.
   */
  ownerHint?: string;
  /** TTL override (ms) for the newly-minted context. Only honored with newContext=true. */
  ttlMs?: number;
  /** Agent mode to set for this task (e.g. plan, autoEdit, yolo). ACP-only. */
  mode?: string;
  /** Model to use for this task (e.g. gemini-2.5-pro). ACP-only. */
  model?: string;
}

const CONTEXT_ID_REGEX = /^ctx_[a-z0-9]{8}$/;

/**
 * Drop a task into the agent inbox and poll its outbox for the result.
 *
 * Emits structured progress to **stderr** while waiting (queued, claimed,
 * heartbeat). The final TaskResult JSON goes to **stdout** so callers can
 * still pipe to `python3 -m json.tool` or similar.
 *
 * Polling cadence: 50ms for the first 2s (sub-second pings feel instant),
 * 500ms thereafter (cheap on idle filesystems).
 *
 * v1.1: forwards optional contextId / newContext / ownerHint into the
 * envelope. The worker does the actual context plumbing; CLI only validates
 * the basic shape so users get a fast, helpful error before a worker even
 * sees the task.
 */
export async function cmdSend(
  agent: string | undefined,
  prompt: string | undefined,
  opts: SendOptions
): Promise<void> {
  if (!agent || prompt === undefined) {
    process.stderr.write(
      'Usage: crewmate send <agent> <prompt> [--timeout=ms] [--cwd=path]\n' +
        '                                 [--context=<id> | --new-context [--owner-hint=<tag>]]\n'
    );
    process.exit(2);
  }

  if (!/^[a-z][a-z0-9-]{0,63}$/.test(agent)) {
    process.stderr.write(
      `[crewmate] invalid agent name: "${agent}" — must be lowercase alphanumeric with hyphens\n`
    );
    process.exit(2);
  }

  // CLI-layer validation — the envelope refinement also catches mutual
  // exclusion, but failing here gives a clearer error before the envelope
  // is even built.
  if (opts.newContext && opts.contextId !== undefined) {
    process.stderr.write(
      '[crewmate] --new-context and --context are mutually exclusive; pass one or neither.\n'
    );
    process.exit(2);
  }
  if (opts.contextId !== undefined && !CONTEXT_ID_REGEX.test(opts.contextId)) {
    process.stderr.write(
      `Invalid --context: must look like "ctx_xxxxxxxx" (got: ${opts.contextId})\n`
    );
    process.exit(2);
  }

  await ensureAgentTree(agent);

  const taskId = uuidv4();
  const envelope: TaskRequestInput = {
    taskId,
    agent,
    prompt,
    context: { cwd: opts.cwd ?? process.cwd() },
    timeoutMs: opts.timeoutMs,
    createdAt: new Date().toISOString(),
  };
  // Only attach v1.1 fields if the caller explicitly opted in. This keeps
  // v1.0-style invocations producing byte-identical envelopes (after zod
  // default-fill); the worker treats absence as "fresh, no context."
  if (opts.contextId !== undefined) {
    envelope.contextId = opts.contextId;
    envelope.version = 2;
  }
  if (opts.newContext) {
    envelope.newContext = true;
    envelope.version = 2;
  }
  if (opts.ownerHint !== undefined) {
    // Pass through even without --new-context: the worker ignores it in
    // that case, and silently dropping it on the CLI side would be
    // misleading if a continuation ever started honoring it.
    envelope.ownerHint = opts.ownerHint;
    envelope.version = 2;
  }
  if (opts.ttlMs !== undefined) {
    envelope.ttlMs = opts.ttlMs;
    envelope.version = 2;
  }
  if (opts.mode !== undefined) {
    envelope.mode = opts.mode;
    envelope.version = 2;
  }
  if (opts.model !== undefined) {
    envelope.model = opts.model;
    envelope.version = 2;
  }

  // Pre-flight: if no alive worker exists for this agent, start one NOW
  // before even writing the task. Saves the 3s detection delay.
  if (!(await hasAliveWorker(agent))) {
    process.stderr.write(
      `[crewmate] no worker running — auto-starting pool for ${agent}\n`
    );
    try {
      await autoStartPool(agent);
      // Brief pause for the worker to boot and start watching inbox.
      await sleep(800);
    } catch (err) {
      process.stderr.write(
        `[crewmate] auto-start failed: ${(err as Error).message}\n` +
        `[crewmate] start manually: crewmate up ${agent}\n`
      );
    }
  }

  await writeTaskRequest(agent, envelope);
  log({ event: 'task_received', agent, taskId });
  process.stderr.write(`[crewmate] task ${taskId} → ${agent} (queued)\n`);

  const resultPath = outboxResultPath(agent, taskId);
  const deadline = Date.now() + opts.timeoutMs + 5_000; // grace beyond worker timeout
  const startMs = Date.now();
  const HEARTBEAT_MS = 5_000;

  let claimedPid: string | null = null;
  let lastHeartbeatAt = 0;
  let stdoutOffset = 0;
  let stderrOffset = 0;
  let progressOffset = 0;
  const outLogPath = stdoutLogPath(agent, taskId);
  const errLogPath = stderrLogPath(agent, taskId);
  const progLogPath = progressLogPath(agent, taskId);

  while (Date.now() < deadline) {
    // 1. Result ready?
    try {
      await fs.access(resultPath);
      // Flush any remaining output before returning the result.
      await streamWorkerChunk(progLogPath, progressOffset, `${agent}:tool`);
      await streamWorkerChunk(errLogPath, stderrOffset, `${agent}:process`);
      await streamWorkerChunk(outLogPath, stdoutOffset, agent);
      const result = await readTaskResult(resultPath);
      const ms = Date.now() - startMs;
      const ctxSuffix =
        result.contextId && result.turnNumber !== undefined
          ? ` (context: ${result.contextId}, turn ${result.turnNumber})`
          : '';
      const tokenSuffix =
        result.usage.inputTokens !== undefined
          ? ` (${result.usage.inputTokens} in / ${result.usage.outputTokens ?? 0} out tokens)`
          : '';
      process.stderr.write(
        `[crewmate] task ${taskId} → ${result.status} in ${ms}ms${ctxSuffix}${tokenSuffix}\n`
      );
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exit(result.status === 'completed' ? 0 : 1);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    // 2. Has anyone claimed it yet?
    if (!claimedPid) {
      const pid = await findClaimedPid(agent, taskId);
      if (pid) {
        claimedPid = pid;
        process.stderr.write(
          `[crewmate] task ${taskId} → claimed by worker pid=${pid}\n`
        );
      }
    }

    // 3. Stream live worker output — tail log files and emit new chunks.
    if (claimedPid) {
      progressOffset = await streamWorkerChunk(progLogPath, progressOffset, `${agent}:tool`);
      stderrOffset = await streamWorkerChunk(errLogPath, stderrOffset, `${agent}:process`);
      stdoutOffset = await streamWorkerChunk(outLogPath, stdoutOffset, agent);
    }

    // 4. Periodic heartbeat
    const elapsed = Date.now() - startMs;
    if (elapsed - lastHeartbeatAt >= HEARTBEAT_MS) {
      const secs = Math.floor(elapsed / 1000);
      const tag = claimedPid ? `running (pid=${claimedPid})` : 'awaiting claim';
      process.stderr.write(
        `[crewmate] task ${taskId} → ${tag} ${secs}s elapsed\n`
      );
      lastHeartbeatAt = elapsed;
    }

    // 5. Polling backoff
    await sleep(elapsed < 2000 ? 50 : 500);
  }

  process.stderr.write(
    `[crewmate] timed out after ${opts.timeoutMs}ms waiting for result of ${taskId}\n`
  );
  process.exit(124);
}

/**
 * Scan workers/<pid>/ subdirs for the claimed task file. Returns the pid (as
 * a string, since dir name is a string) or null if not yet claimed.
 */
async function findClaimedPid(
  agent: string,
  taskId: string
): Promise<string | null> {
  const root = workersDir(agent);
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = `${root}/${entry.name}/${taskId}.task.json`;
    try {
      await fs.access(candidate);
      return entry.name;
    } catch {
      // not in this worker's dir
    }
  }
  return null;
}

/**
 * Check if any worker process is alive for this agent by scanning
 * workers/<pid>/ dirs and probing each PID. One alive PID = pool running.
 * Takes <1ms on a typical workers/ tree (handful of dirs at most).
 */
async function hasAliveWorker(agent: string): Promise<boolean> {
  const root = workersDir(agent);
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pid = Number(entry.name);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 0);
      return true; // at least one alive
    } catch {
      // dead pid — keep scanning
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read newly-appended bytes from the worker's stdout log and emit them
 * to our stderr, prefixed with the agent name. Returns the new offset.
 * Silent on ENOENT (log hasn't been created yet — worker hasn't started
 * writing) and on no-new-data (nothing appended since last poll).
 */
async function streamWorkerChunk(
  logPath: string,
  offset: number,
  agent: string
): Promise<number> {
  let stat;
  try {
    stat = await fs.stat(logPath);
  } catch {
    return offset; // file doesn't exist yet
  }
  if (stat.size <= offset) return offset; // no new data

  const fd = await fs.open(logPath, 'r');
  try {
    const len = stat.size - offset;
    const buf = Buffer.alloc(len);
    await fd.read(buf, 0, len, offset);
    const text = buf.toString('utf8');
    // Emit each line with a prefix so the orchestrator can distinguish
    // worker output from crewmate's own progress lines.
    for (const line of text.split('\n')) {
      if (line.length > 0) {
        process.stderr.write(`[${agent}] ${line}\n`);
      }
    }
    return stat.size;
  } finally {
    await fd.close();
  }
}


/**
 * Spawn `crewmate up <agent> --workers=1` as a detached background process.
 * The pool stays alive after `send` exits, ready for subsequent sends.
 * Detached + unref'd so the parent (send) doesn't wait for it.
 *
 * Safe to call even if a pool is already running — extra workers just
 * compete via atomic inbox claim, no conflicts.
 */
async function autoStartPool(agent: string): Promise<void> {
  const cliScript = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'cli.ts'
  );
  const logPath = path.join(homeDir(), `${agent}-autostart.log`);
  const logFd = await fs.open(logPath, 'a');

  const proc = Bun.spawn(['bun', cliScript, 'up', agent, '--workers=1'], {
    env: {
      ...process.env,
      CREWMATE_HOME: homeDir(),
    },
    stdin: 'ignore',
    stdout: logFd.fd as unknown as 'ignore',
    stderr: logFd.fd as unknown as 'ignore',
  });

  // Detach: don't let this send process wait for the pool to exit.
  proc.unref();

  log({
    event: 'pool_auto_started',
    agent,
    pid: proc.pid,
    message: `auto-started by send (log: ${logPath})`,
  });
}
