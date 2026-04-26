import { z } from 'zod';
import { listAgentNames } from '../../paths.ts';
import { purgeArchivedOlderThan } from '../../transports/mailbox.ts';
import { log } from '../../logger.ts';
import type { ToolReturn } from '../types.ts';

/**
 * Zod input shape for `crewmate_purge_archived`. Permanently deletes archived
 * (TTL'd or explicitly destroyed) contexts older than `olderThan`. Mirrors the
 * Bash `crewmate context purge --older-than=<duration>` subcommand.
 */
export const purgeArchivedInputShape = {
  olderThan: z
    .string()
    .regex(
      /^\d+(ms|s|m|h|d)$/,
      'olderThan must be a duration like "7d", "24h", "30m", "60s", or "0s" to purge everything.'
    )
    .describe(
      'Duration threshold. Archived contexts whose lastUsed is older than now-<duration> are deleted. Examples: "7d", "24h", "30m", "60s", "0s" (purge everything).'
    ),
  agent: z
    .string()
    .optional()
    .describe(
      'If given, purge only this agent. Otherwise purge across every initialized agent.'
    ),
};

const purgeArgs = z.object(purgeArchivedInputShape);
type PurgeArgs = z.infer<typeof purgeArgs>;

/**
 * Parse "7d", "24h", "30m", "60s", "0s", "100ms" → milliseconds. Returns null
 * for unrecognized shapes (the schema regex catches most cases first; this is
 * a defensive double-check).
 */
function parseDuration(s: string): number | null {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  switch (m[2]) {
    case 'ms':
      return n;
    case 's':
      return n * 1_000;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 3_600_000;
    case 'd':
      return n * 86_400_000;
    default:
      return null;
  }
}

export async function purgeArchivedHandler(
  args: PurgeArgs
): Promise<ToolReturn> {
  const cutoffMs = parseDuration(args.olderThan);
  if (cutoffMs === null) {
    return {
      content: [
        {
          type: 'text',
          text: `Invalid olderThan duration: ${args.olderThan}`,
        },
      ],
      isError: true,
      structuredContent: { error: 'invalid_duration', olderThan: args.olderThan },
    };
  }

  const agents = args.agent
    ? [args.agent]
    : await listAgentNames();

  if (agents.length === 0) {
    return {
      content: [{ type: 'text', text: 'No agents initialized.' }],
      structuredContent: { purged: 0, agents: [] },
    };
  }

  const perAgent: Array<{ agent: string; purged: number }> = [];
  let total = 0;
  for (const agent of agents) {
    try {
      const n = await purgeArchivedOlderThan(agent, cutoffMs);
      perAgent.push({ agent, purged: n });
      total += n;
    } catch (err) {
      log({
        event: 'mcp_tool_call',
        tool: 'crewmate_purge_archived',
        agent,
        error: (err as Error).message,
      });
      perAgent.push({ agent, purged: 0 });
    }
  }

  log({
    event: 'mcp_tool_call',
    tool: 'crewmate_purge_archived',
    agent: args.agent,
    message: `purged ${total} archived context(s) older than ${args.olderThan}`,
  });

  const summary =
    total === 0
      ? `No archived contexts older than ${args.olderThan}.`
      : `Purged ${total} archived context(s) older than ${args.olderThan}` +
        (args.agent ? ` (agent: ${args.agent}).` : ` across ${agents.length} agent(s).`);

  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: {
      purged: total,
      cutoffMs,
      olderThan: args.olderThan,
      perAgent,
    },
  };
}
