import { z } from 'zod';
import { listAgentNames } from '../../paths.ts';
import {
  listContextIds,
  readContextMeta,
  readContextTurns,
  ContextNotFoundError,
} from '../../transports/mailbox.ts';
import { log } from '../../logger.ts';
import type { ContextTurn } from '../../envelope.ts';
import type { ToolReturn } from '../types.ts';

const ContextIdPattern = /^ctx_[a-z0-9]{8}$/;

/** Cap on the assembled `reconstructedNextPrompt` block to keep host token cost predictable. */
const RECONSTRUCT_BUDGET_BYTES = 200_000;

/**
 * Zod input shape for `crewmate_show_context`. Returns the full transcript
 * for inspection. `tail` and `turn` are mutually exclusive; both let callers
 * limit the size of the returned payload.
 */
export const showContextInputShape = {
  contextId: z
    .string()
    .regex(ContextIdPattern, 'contextId must look like "ctx_<8 chars from a-z0-9>"')
    .describe('The contextId to inspect (e.g. ctx_abcd2345).'),
  agent: z
    .string()
    .optional()
    .describe('If given, only look in this agent. Otherwise scan all agents.'),
  tail: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('If given, return only the last N turns. Mutually exclusive with `turn`.'),
  turn: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('If given, return only that specific 1-indexed turn number. Mutually exclusive with `tail`.'),
};

async function findOwningAgent(contextId: string): Promise<string | null> {
  const agents = await listAgentNames();
  for (const agent of agents) {
    const ids = await listContextIds(agent).catch(() => [] as string[]);
    if (!ids.includes(contextId)) continue;
    try {
      await readContextMeta(agent, contextId);
      return agent;
    } catch {
      // skip — treat as not-an-owner
    }
  }
  return null;
}

/**
 * Build a "what would the next prompt look like" reconstruction by replaying
 * every prior turn as a Q/A pair. Returns null if the result would exceed
 * RECONSTRUCT_BUDGET_BYTES — the caller substitutes a placeholder.
 */
function reconstructNextPrompt(turns: ContextTurn[]): string | null {
  if (turns.length === 0) return '';
  const parts: string[] = [];
  let bytes = 0;
  for (const turn of turns) {
    const block =
      `--- turn ${turns.indexOf(turn) + 1} ---\n` +
      `User: ${turn.prompt}\n` +
      `Assistant: ${turn.response}\n`;
    bytes += Buffer.byteLength(block, 'utf8');
    if (bytes > RECONSTRUCT_BUDGET_BYTES) return null;
    parts.push(block);
  }
  return parts.join('\n');
}

function humanAge(ageMs: number): string {
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s`;
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h`;
  return `${Math.floor(ageMs / 86_400_000)}d`;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

export async function handleShowContext(args: {
  contextId: string;
  agent?: string;
  tail?: number;
  turn?: number;
}): Promise<ToolReturn> {
  // Mutual exclusion guard. The Zod schema can't express "exactly one of".
  if (args.tail !== undefined && args.turn !== undefined) {
    return {
      content: [
        { type: 'text', text: 'tail and turn are mutually exclusive' },
      ],
      structuredContent: {
        contextId: args.contextId,
        error: 'tail_and_turn_exclusive',
      },
      isError: true,
    };
  }

  // Locate the owning agent.
  let agent: string;
  if (args.agent) {
    try {
      await readContextMeta(args.agent, args.contextId);
    } catch (err) {
      if (err instanceof ContextNotFoundError) {
        log({
          event: 'mcp_tool_call',
          agent: args.agent,
          message: `show_context not_found contextId=${args.contextId}`,
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
    const owner = await findOwningAgent(args.contextId);
    if (!owner) {
      log({
        event: 'mcp_tool_call',
        message: `show_context not_found contextId=${args.contextId}`,
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
    agent = owner;
  }

  const meta = await readContextMeta(agent, args.contextId);
  const allTurns = await readContextTurns(agent, args.contextId);

  // Apply tail / turn filter.
  let turns: ContextTurn[];
  if (args.turn !== undefined) {
    // 1-indexed selection; out-of-range is empty (not an error — defensible
    // for "show me turn 5 of a 3-turn context" rather than blow up).
    turns = args.turn >= 1 && args.turn <= allTurns.length
      ? [allTurns[args.turn - 1]!]
      : [];
  } else if (args.tail !== undefined) {
    turns = allTurns.slice(-args.tail);
  } else {
    turns = allTurns;
  }

  // Reconstructed prompt: only meaningful when returning the full transcript.
  // For partial views (tail/turn) we omit it to avoid implying the snippet is
  // a complete replay.
  let reconstructedNextPrompt: string | undefined;
  let reconstructedSkipped = false;
  if (args.tail === undefined && args.turn === undefined) {
    const built = reconstructNextPrompt(allTurns);
    if (built === null) reconstructedSkipped = true;
    else reconstructedNextPrompt = built;
  }

  // Total bytes for the human summary — reuse readContextTurns output rather
  // than re-statting files since we already have the parsed payloads.
  const totalBytes = allTurns.reduce(
    (sum, t) => sum + Buffer.byteLength(JSON.stringify(t), 'utf8'),
    0
  );
  const ageMs = Math.max(0, Date.now() - new Date(meta.lastUsed).getTime());

  const summary =
    `Context ${args.contextId} for ${agent} — ` +
    `${meta.turnCount} turn${meta.turnCount === 1 ? '' : 's'}, ` +
    `last used ${humanAge(ageMs)} ago, ${humanBytes(totalBytes)} total.`;

  log({
    event: 'mcp_tool_call',
    agent,
    message: `show_context contextId=${args.contextId} turns=${turns.length}`,
  });

  const structuredContent: Record<string, unknown> = {
    contextId: meta.contextId,
    agent,
    meta: {
      created: meta.created,
      lastUsed: meta.lastUsed,
      ownerHint: meta.ownerHint,
      turnCount: meta.turnCount,
      ttlMs: meta.ttlMs,
    },
    turns,
  };
  if (reconstructedNextPrompt !== undefined) {
    structuredContent.reconstructedNextPrompt = reconstructedNextPrompt;
  } else if (reconstructedSkipped) {
    structuredContent.reconstructedNextPrompt =
      `(omitted: would exceed ${RECONSTRUCT_BUDGET_BYTES} bytes — call show_context with tail/turn to inspect a slice)`;
  }

  return {
    content: [{ type: 'text', text: summary }],
    structuredContent,
  };
}
