import fs from 'node:fs/promises';
import { z } from 'zod';
import { agentDir } from '../../paths.ts';
import { createContext } from '../../transports/mailbox.ts';
import { log } from '../../logger.ts';
import type { ToolReturn } from '../types.ts';

/**
 * Zod input shape for `crewmate_new_context`. Mints a fresh context for the
 * given agent without sending a task. Useful when an orchestrator wants to
 * establish a session up-front and reference its contextId on later sends.
 */
export const newContextInputShape = {
  agent: z
    .string()
    .describe('Name of the crewmate agent that will own the new context.'),
  ownerHint: z
    .string()
    .max(64)
    .optional()
    .describe(
      'Free-form label (≤64 chars) stored in meta.json — handy for filtering ' +
        'in `crewmate_list_contexts`.'
    ),
  ttlMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Idle TTL in ms before the sweeper archives this context (default 1800000 = 30m).'),
};

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30m — matches ContextMeta default

async function agentExists(name: string): Promise<boolean> {
  try {
    const stat = await fs.stat(agentDir(name));
    return stat.isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export async function handleNewContext(args: {
  agent: string;
  ownerHint?: string;
  ttlMs?: number;
}): Promise<ToolReturn> {
  // Refuse to mint a context for an unknown agent. Doing so silently would
  // create a half-broken tree that no worker can ever drive.
  if (!(await agentExists(args.agent))) {
    log({
      event: 'mcp_tool_call',
      agent: args.agent,
      message: `new_context refused: agent ${args.agent} not initialized`,
    });
    return {
      content: [
        {
          type: 'text',
          text: `Agent ${args.agent} is not initialized. Run \`crewmate init\` first.`,
        },
      ],
      structuredContent: { agent: args.agent, error: 'agent_not_initialized' },
      isError: true,
    };
  }

  const ttlMs = args.ttlMs ?? DEFAULT_TTL_MS;
  const meta = await createContext(args.agent, {
    ownerHint: args.ownerHint,
    ttlMs,
  });

  log({
    event: 'mcp_tool_call',
    agent: args.agent,
    message: `new_context contextId=${meta.contextId}`,
  });

  return {
    content: [
      { type: 'text', text: `Created ${meta.contextId} for ${args.agent}` },
    ],
    structuredContent: {
      contextId: meta.contextId,
      agent: meta.agent,
      ownerHint: meta.ownerHint,
      ttlMs: meta.ttlMs,
      created: meta.created,
    },
  };
}
