import fs from 'node:fs/promises';
import { z } from 'zod';
import {
  inboxDir,
  outboxDir,
  workersDir,
  processedDir,
  cancelDir,
  inboxTaskPath,
  outboxResultPath,
  cancelSentinelPath,
  processedTaskPath,
  workerTaskPath,
  listAgentNames,
} from '../../paths.ts';
import { log } from '../../logger.ts';
import type { ToolReturn } from '../types.ts';

export const statusInputShape = {
  taskId: z
    .string()
    .optional()
    .describe('If given, locate this specific task across all agents. Otherwise return queue counts per agent.'),
};

interface PerAgentCounts {
  inbox: number;
  claimed: number;
  completed: number;
  canceled: number;
}

type TaskState = 'pending' | 'claimed' | 'completed' | 'canceled' | 'unknown';

interface TaskLocation {
  taskId: string;
  agent: string | null;
  state: TaskState;
  pid?: string;
  path?: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function countMatching(dir: string, suffix: string): Promise<number> {
  try {
    const entries = await fs.readdir(dir);
    return entries.filter((e) => !e.startsWith('.') && e.endsWith(suffix)).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

async function countCancelSentinels(agent: string): Promise<number> {
  try {
    const entries = await fs.readdir(cancelDir(agent));
    return entries.filter((e) => !e.startsWith('.')).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

async function countClaimed(agent: string): Promise<number> {
  try {
    const pids = await fs.readdir(workersDir(agent), { withFileTypes: true });
    let total = 0;
    for (const ent of pids) {
      if (!ent.isDirectory()) continue;
      const inner = await fs.readdir(`${workersDir(agent)}/${ent.name}`);
      total += inner.filter((f) => f.endsWith('.task.json')).length;
    }
    return total;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

async function countsFor(agent: string): Promise<PerAgentCounts> {
  const [inbox, claimed, completed, canceled] = await Promise.all([
    countMatching(inboxDir(agent), '.task.json'),
    countClaimed(agent),
    countMatching(outboxDir(agent), '.result.json'),
    countCancelSentinels(agent),
  ]);
  return { inbox, claimed, completed, canceled };
}

/**
 * For a given taskId, determine which agent owns it and what state the task
 * is in. We check in order: outbox (most authoritative — the task is
 * complete), processed (also done), workers/<pid>/ (claimed), cancel/
 * (cancel pending), inbox (still queued).
 */
async function locateTask(taskId: string): Promise<TaskLocation> {
  const agents = await listAgentNames();
  for (const agent of agents) {
    // outbox = completed (or terminal: failed/timeout/canceled)
    if (await exists(outboxResultPath(agent, taskId))) {
      return {
        taskId,
        agent,
        state: 'completed',
        path: outboxResultPath(agent, taskId),
      };
    }
    // processed = run finished, archive of the claimed file
    if (await exists(processedTaskPath(agent, taskId))) {
      return {
        taskId,
        agent,
        state: 'completed',
        path: processedTaskPath(agent, taskId),
      };
    }
    // workers/<pid>/ = currently running
    try {
      const pids = await fs.readdir(workersDir(agent), { withFileTypes: true });
      for (const ent of pids) {
        if (!ent.isDirectory()) continue;
        const candidate = workerTaskPath(agent, ent.name, taskId);
        if (await exists(candidate)) {
          return {
            taskId,
            agent,
            state: 'claimed',
            pid: ent.name,
            path: candidate,
          };
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    // cancel sentinel without a result yet = canceled (in flight or pre-claim)
    if (await exists(cancelSentinelPath(agent, taskId))) {
      return {
        taskId,
        agent,
        state: 'canceled',
        path: cancelSentinelPath(agent, taskId),
      };
    }
    // inbox = still pending
    if (await exists(inboxTaskPath(agent, taskId))) {
      return {
        taskId,
        agent,
        state: 'pending',
        path: inboxTaskPath(agent, taskId),
      };
    }
  }
  return { taskId, agent: null, state: 'unknown' };
}

export async function handleStatus(args: {
  taskId?: string;
}): Promise<ToolReturn> {
  if (args.taskId) {
    const loc = await locateTask(args.taskId);
    log({
      event: 'mcp_tool_call',
      taskId: args.taskId,
      message: `status -> ${loc.state}${loc.agent ? ` (${loc.agent})` : ''}`,
    });
    return {
      content: [
        {
          type: 'text',
          text: `${args.taskId}: ${loc.state}${loc.agent ? ` (agent=${loc.agent}${loc.pid ? `, pid=${loc.pid}` : ''})` : ''}`,
        },
      ],
      structuredContent: loc as unknown as Record<string, unknown>,
    };
  }

  const agents = await listAgentNames();
  const out: Record<string, PerAgentCounts> = {};
  for (const agent of agents) {
    out[agent] = await countsFor(agent);
  }
  log({ event: 'mcp_tool_call', message: `status (aggregate, ${agents.length} agents)` });

  const lines = agents.map((a) => {
    const c = out[a]!;
    return `${a}\tinbox=${c.inbox}\tclaimed=${c.claimed}\tcompleted=${c.completed}\tcanceled=${c.canceled}`;
  });
  return {
    content: [{ type: 'text', text: lines.length ? lines.join('\n') : '(no agents)' }],
    structuredContent: out as unknown as Record<string, unknown>,
  };
}
