import fs from 'node:fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import {
  ensureAgentTree,
  outboxResultPath,
  workersDir,
} from '../../paths.ts';
import {
  writeTaskRequest,
  readTaskResult,
  writeCancelSentinel,
} from '../../transports/mailbox.ts';
import { log } from '../../logger.ts';
import type { TaskResult } from '../../envelope.ts';
import type { McpExtra, ToolReturn } from '../types.ts';

/**
 * Zod input schema for the tool. The MCP SDK turns this raw shape into the
 * tool's JSON Schema and into the runtime validator for tool arguments.
 *
 * v1.1 additions: contextId / newContext / ownerHint passthroughs. The
 * envelope-level `refine()` would also catch contextId+newContext together,
 * but we re-check at the tool boundary so the host gets a clean tool error
 * (isError=true) rather than a Zod parse exception.
 */
export const sendAndWaitInputShape = {
  agent: z.string().describe('Name of the crewmate agent to dispatch to (e.g. gemini-worker).'),
  prompt: z.string().describe('The task prompt to send to the agent.'),
  context: z
    .object({
      cwd: z.string().optional(),
      files: z.array(z.string()).optional(),
    })
    .optional()
    .describe('Optional execution context for the worker (cwd, file hints).'),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Per-task timeout in ms (default 300000).'),
  // v1.1 additions
  contextId: z
    .string()
    .regex(/^ctx_[a-z0-9]{8}$/, 'contextId must look like "ctx_<8 chars from a-z0-9>"')
    .optional()
    .describe('Continue an existing worker context. Mutually exclusive with `newContext`.'),
  newContext: z
    .boolean()
    .optional()
    .describe('Mint a fresh context for this task. Mutually exclusive with `contextId`.'),
  ownerHint: z
    .string()
    .max(64)
    .optional()
    .describe('Free-form label (≤64 chars) stored on the new context. Only meaningful when `newContext: true`.'),
  mode: z
    .string()
    .optional()
    .describe('Agent mode for ACP workers (e.g. plan, autoEdit, yolo). Ignored by spawn workers.'),
  model: z
    .string()
    .optional()
    .describe('Model to use for ACP workers (e.g. gemini-2.5-pro, gemini-3-flash-preview). Ignored by spawn workers.'),
};

const HEARTBEAT_MS = 5_000;

export async function handleSendAndWait(
  args: {
    agent: string;
    prompt: string;
    context?: { cwd?: string; files?: string[] };
    timeoutMs?: number;
    contextId?: string;
    newContext?: boolean;
    ownerHint?: string;
    mode?: string;
    model?: string;
  },
  extra: McpExtra
): Promise<ToolReturn> {
  // v1.1 mutual-exclusion guard at the tool boundary. The envelope schema
  // would also reject this, but we surface it as a clean tool error so the
  // host displays the message rather than a stack trace.
  if (args.newContext === true && args.contextId !== undefined) {
    log({
      event: 'mcp_tool_call',
      agent: args.agent,
      message: 'send_and_wait rejected: contextId+newContext both set',
    });
    return {
      content: [
        { type: 'text', text: 'contextId and newContext are mutually exclusive' },
      ],
      structuredContent: {
        agent: args.agent,
        error: 'context_args_exclusive',
      },
      isError: true,
    };
  }

  const timeoutMs = args.timeoutMs ?? 300_000;
  const taskId = uuidv4();
  const progressToken = extra._meta?.progressToken;

  await ensureAgentTree(args.agent);

  await writeTaskRequest(args.agent, {
    taskId,
    agent: args.agent,
    prompt: args.prompt,
    context: args.context,
    timeoutMs,
    createdAt: new Date().toISOString(),
    // v1.1 passthroughs — only set when the caller actually provided them
    // so v1 envelopes stay byte-identical to pre-1.1 behavior.
    ...(args.contextId !== undefined ? { contextId: args.contextId } : {}),
    ...(args.newContext === true ? { newContext: true } : {}),
    ...(args.ownerHint !== undefined ? { ownerHint: args.ownerHint } : {}),
    ...(args.mode !== undefined ? { mode: args.mode } : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
  });
  log({ event: 'mcp_tool_call', agent: args.agent, taskId, message: 'send_and_wait queued' });

  if (progressToken !== undefined) {
    await extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken, progress: 0, message: 'queued' },
    });
  }

  const resultPath = outboxResultPath(args.agent, taskId);
  const startMs = Date.now();
  const deadline = startMs + timeoutMs + 5_000;
  let claimedPid: string | null = null;
  let lastHeartbeatAt = 0;
  let canceledByClient = false;

  // Hook the per-request abort signal: if Claude Code cancels the MCP call
  // mid-flight we drop a cancel sentinel for the in-flight task so the
  // worker tears down cleanly instead of leaking.
  const onAbort = (): void => {
    canceledByClient = true;
    void writeCancelSentinel(args.agent, taskId).catch(() => undefined);
    log({
      event: 'mcp_tool_call',
      agent: args.agent,
      taskId,
      message: 'send_and_wait aborted by client',
    });
  };
  if (extra.signal.aborted) onAbort();
  else extra.signal.addEventListener('abort', onAbort, { once: true });

  try {
    while (Date.now() < deadline) {
      // 1. Result ready?
      try {
        await fs.access(resultPath);
        const result = await readTaskResult(resultPath);
        // v1.1: emit a final progress beat naming the context+turn so hosts
        // that show progress have something nicer than a silent terminus.
        // Skip for v1 (no contextId) tasks — keeps existing clients quiet.
        if (
          progressToken !== undefined &&
          result.contextId &&
          result.turnNumber !== undefined
        ) {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: 100,
              total: 100,
              message: `completed turn ${result.turnNumber} of context ${result.contextId}`,
            },
          });
        }
        return resultToReturn(result);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }

      // 2. Has anyone claimed it yet?
      if (!claimedPid) {
        const pid = await findClaimedPid(args.agent, taskId);
        if (pid) {
          claimedPid = pid;
          if (progressToken !== undefined) {
            await extra.sendNotification({
              method: 'notifications/progress',
              params: {
                progressToken,
                progress: 1,
                total: 100,
                message: `claimed by pid=${pid}`,
              },
            });
          }
        }
      }

      // 3. Periodic heartbeat (every 5s of wall-time)
      const elapsed = Date.now() - startMs;
      if (
        progressToken !== undefined &&
        elapsed - lastHeartbeatAt >= HEARTBEAT_MS
      ) {
        const secs = Math.floor(elapsed / 1000);
        await extra.sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken,
            progress: secs,
            total: Math.floor(timeoutMs / 1000),
            message: `running, ${secs}s elapsed`,
          },
        });
        lastHeartbeatAt = elapsed;
      }

      // 4. If the client canceled, stop polling and return a synthetic canceled result.
      if (canceledByClient) {
        const synth: TaskResult = {
          taskId,
          agent: args.agent,
          status: 'canceled',
          summary: 'Canceled by MCP client',
          result: '',
          error: 'Canceled by MCP client (request aborted)',
          usage: {
            durationMs: Date.now() - startMs,
            exitCode: null,
            stdoutBytes: 0,
          },
          completedAt: new Date().toISOString(),
        };
        return resultToReturn(synth);
      }

      // 5. Backoff: 50ms for the first 2s (snappy), 500ms after.
      await sleep(elapsed < 2000 ? 50 : 500);
    }

    // Hard timeout: synthesize a TaskResult so callers get a structured payload.
    const synth: TaskResult = {
      taskId,
      agent: args.agent,
      status: 'timeout',
      summary: `Timed out after ${timeoutMs}ms`,
      result: '',
      error: `MCP send_and_wait exceeded timeoutMs=${timeoutMs}`,
      usage: {
        durationMs: Date.now() - startMs,
        exitCode: null,
        stdoutBytes: 0,
      },
      completedAt: new Date().toISOString(),
    };
    return resultToReturn(synth);
  } finally {
    extra.signal.removeEventListener('abort', onAbort);
  }
}

function resultToReturn(result: TaskResult): ToolReturn {
  return {
    content: [{ type: 'text', text: result.result || result.summary }],
    structuredContent: result as unknown as Record<string, unknown>,
    isError: result.status !== 'completed',
  };
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
