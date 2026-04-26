import fs from 'node:fs/promises';
import { z } from 'zod';
import {
  inboxTaskPath,
  outboxResultPath,
  processedTaskPath,
  workersDir,
  workerTaskPath,
  listAgentNames,
} from '../../paths.ts';
import { writeCancelSentinel } from '../../transports/mailbox.ts';
import { log } from '../../logger.ts';
import type { ToolReturn } from '../types.ts';

export const cancelInputShape = {
  taskId: z.string().describe('The taskId to cancel.'),
  agent: z
    .string()
    .optional()
    .describe('Optional agent name. If omitted, scan all agents to find the owner.'),
};

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find which agent owns the given taskId by checking inbox/, workers/<pid>/,
 * outbox/, and processed/. Returns null if no agent has any record of the
 * task — in which case the caller may want to refuse to write a cancel
 * sentinel rather than create a stray file.
 */
async function findOwningAgent(taskId: string): Promise<string | null> {
  const agents = await listAgentNames();
  for (const agent of agents) {
    if (await exists(inboxTaskPath(agent, taskId))) return agent;
    if (await exists(outboxResultPath(agent, taskId))) return agent;
    if (await exists(processedTaskPath(agent, taskId))) return agent;
    try {
      const pids = await fs.readdir(workersDir(agent), { withFileTypes: true });
      for (const ent of pids) {
        if (!ent.isDirectory()) continue;
        if (await exists(workerTaskPath(agent, ent.name, taskId))) return agent;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return null;
}

export async function handleCancel(args: {
  taskId: string;
  agent?: string;
}): Promise<ToolReturn> {
  const agent = args.agent ?? (await findOwningAgent(args.taskId));
  if (!agent) {
    log({
      event: 'mcp_tool_call',
      taskId: args.taskId,
      message: 'cancel: no agent owns this task',
    });
    return {
      content: [
        {
          type: 'text',
          text: `No agent owns task ${args.taskId}. Cancel sentinel NOT written.`,
        },
      ],
      structuredContent: { taskId: args.taskId, agent: null, written: false },
      isError: true,
    };
  }

  const dest = await writeCancelSentinel(agent, args.taskId);
  log({
    event: 'mcp_tool_call',
    agent,
    taskId: args.taskId,
    message: 'cancel sentinel written via MCP',
  });
  return {
    content: [
      { type: 'text', text: `cancel sentinel written: ${dest}` },
    ],
    structuredContent: {
      taskId: args.taskId,
      agent,
      written: true,
      path: dest,
    },
  };
}
