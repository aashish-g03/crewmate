import { z } from 'zod';
import { listAgentNames } from '../../paths.ts';
import {
  archiveContext,
  listContextIds,
  readContextMeta,
  ContextNotFoundError,
} from '../../transports/mailbox.ts';
import { log } from '../../logger.ts';
import type { ToolReturn } from '../types.ts';

const ContextIdPattern = /^ctx_[a-z0-9]{8}$/;

/**
 * Zod input shape for `crewmate_destroy_context`. Archives an active context
 * (rename to contexts/.archived/<id>/). When `agent` is omitted we scan every
 * known agent for the contextId — useful when the caller doesn't track the
 * owning agent locally.
 */
export const destroyContextInputShape = {
  contextId: z
    .string()
    .regex(ContextIdPattern, 'contextId must look like "ctx_<8 chars from a-z0-9>"')
    .describe('The contextId to archive (e.g. ctx_abcd2345).'),
  agent: z
    .string()
    .optional()
    .describe('If given, only archive in this agent. Otherwise scan all agents.'),
};

/**
 * Find every (agent, contextId) pair for a given contextId. Returns the list
 * of agents whose `contexts/<id>/` dir contains a parseable meta.json.
 */
async function findOwningAgents(contextId: string): Promise<string[]> {
  const agents = await listAgentNames();
  const owners: string[] = [];
  for (const agent of agents) {
    const ids = await listContextIds(agent).catch(() => [] as string[]);
    if (!ids.includes(contextId)) continue;
    // Confirm meta.json reads — directory might exist but be a leftover.
    try {
      await readContextMeta(agent, contextId);
      owners.push(agent);
    } catch {
      // ignore — treat as not-an-owner
    }
  }
  return owners;
}

export async function handleDestroyContext(args: {
  contextId: string;
  agent?: string;
}): Promise<ToolReturn> {
  let agent: string;

  if (args.agent) {
    // Validate the context exists for the named agent before we archive.
    try {
      await readContextMeta(args.agent, args.contextId);
    } catch (err) {
      if (err instanceof ContextNotFoundError) {
        log({
          event: 'mcp_tool_call',
          agent: args.agent,
          message: `destroy_context not_found contextId=${args.contextId}`,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Context ${args.contextId} not found for agent ${args.agent}.`,
            },
          ],
          structuredContent: {
            contextId: args.contextId,
            agent: args.agent,
            error: 'context_not_found',
          },
          isError: true,
        };
      }
      throw err;
    }
    agent = args.agent;
  } else {
    const owners = await findOwningAgents(args.contextId);
    if (owners.length === 0) {
      log({
        event: 'mcp_tool_call',
        message: `destroy_context not_found contextId=${args.contextId}`,
      });
      return {
        content: [
          { type: 'text', text: `Context ${args.contextId} not found in any agent.` },
        ],
        structuredContent: {
          contextId: args.contextId,
          agent: null,
          error: 'context_not_found',
        },
        isError: true,
      };
    }
    if (owners.length > 1) {
      log({
        event: 'mcp_tool_call',
        message:
          `destroy_context ambiguous contextId=${args.contextId} ` +
          `agents=${owners.join(',')}`,
      });
      return {
        content: [
          {
            type: 'text',
            text:
              `Context ${args.contextId} found in multiple agents ` +
              `(${owners.join(', ')}). Re-call with an explicit \`agent\`.`,
          },
        ],
        structuredContent: {
          contextId: args.contextId,
          agents: owners,
          error: 'ambiguous_owner',
        },
        isError: true,
      };
    }
    agent = owners[0]!;
  }

  const archivedAt = new Date().toISOString();
  await archiveContext(agent, args.contextId, 'explicit');

  log({
    event: 'mcp_tool_call',
    agent,
    message: `destroy_context archived contextId=${args.contextId}`,
  });

  return {
    content: [
      {
        type: 'text',
        text: `Archived ${args.contextId} for agent ${agent}`,
      },
    ],
    structuredContent: {
      contextId: args.contextId,
      agent,
      archivedAt,
    },
  };
}
