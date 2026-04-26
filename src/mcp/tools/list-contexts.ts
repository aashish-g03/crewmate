import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { contextDir, listAgentNames } from '../../paths.ts';
import {
  listContextIds,
  readContextMeta,
  readAffinityHolder,
  ContextNotFoundError,
} from '../../transports/mailbox.ts';
import { log } from '../../logger.ts';
import type { ToolReturn } from '../types.ts';

/**
 * Zod input shape for `crewmate_list_contexts`. Without an `agent` filter we
 * aggregate across every initialized agent under ~/.crewmate.
 */
export const listContextsInputShape = {
  agent: z
    .string()
    .optional()
    .describe('If given, only list contexts for this agent. Otherwise aggregate across all agents.'),
};

interface ContextEntry {
  agent: string;
  contextId: string;
  turnCount: number;
  ageMs: number;
  lastUsed: string;
  ownerHint?: string;
  totalBytes: number;
  affinityPid: number | null;
  ttlExceeded: boolean;
}

/**
 * Sum the byte sizes of meta.json + every turn file in the context dir.
 * Errors on individual files are swallowed so a half-written turn doesn't
 * blow up a list call — listing must keep working even if disk is messy.
 */
async function totalBytesFor(agent: string, contextId: string): Promise<number> {
  const dir = contextDir(agent, contextId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0;
  }
  let sum = 0;
  for (const name of entries) {
    if (name.startsWith('.') || name.endsWith('.tmp')) continue;
    if (name.includes('.tmp.')) continue; // writeJsonAtomic leftovers
    try {
      const st = await fs.stat(path.join(dir, name));
      if (st.isFile()) sum += st.size;
    } catch {
      // skip silently
    }
  }
  return sum;
}

async function buildEntry(
  agent: string,
  contextId: string,
  now: number
): Promise<ContextEntry | null> {
  let meta;
  try {
    meta = await readContextMeta(agent, contextId);
  } catch (err) {
    if (err instanceof ContextNotFoundError) return null;
    // For schema-validation errors and the like, skip rather than fail the
    // whole listing — surface the issue via logger so an operator can see it.
    log({
      event: 'mcp_tool_call',
      agent,
      message: `list_contexts: skipping ${contextId} (${(err as Error).message})`,
    });
    return null;
  }
  const lastUsedMs = new Date(meta.lastUsed).getTime();
  const ageMs = Math.max(0, now - lastUsedMs);
  const [totalBytes, affinityPid] = await Promise.all([
    totalBytesFor(agent, contextId),
    readAffinityHolder(agent, contextId),
  ]);
  return {
    agent,
    contextId: meta.contextId,
    turnCount: meta.turnCount,
    ageMs,
    lastUsed: meta.lastUsed,
    ownerHint: meta.ownerHint,
    totalBytes,
    affinityPid,
    ttlExceeded: ageMs >= meta.ttlMs,
  };
}

export async function handleListContexts(args: {
  agent?: string;
}): Promise<ToolReturn> {
  const targets = args.agent ? [args.agent] : await listAgentNames();
  const now = Date.now();
  const contexts: ContextEntry[] = [];

  for (const agent of targets) {
    let ids: string[];
    try {
      ids = await listContextIds(agent);
    } catch {
      continue; // missing agent dir = no contexts; tolerate
    }
    for (const id of ids) {
      const entry = await buildEntry(agent, id, now);
      if (entry) contexts.push(entry);
    }
  }

  // Stable ordering: by agent, then most-recently-used first.
  contexts.sort((a, b) => {
    if (a.agent !== b.agent) return a.agent.localeCompare(b.agent);
    return b.lastUsed.localeCompare(a.lastUsed);
  });

  // Per-agent breakdown for the human-readable summary.
  const byAgent = new Map<string, number>();
  for (const c of contexts) {
    byAgent.set(c.agent, (byAgent.get(c.agent) ?? 0) + 1);
  }
  const breakdown = [...byAgent.entries()]
    .map(([a, n]) => `${n} ${a}`)
    .join(', ');
  const summary = contexts.length
    ? `${contexts.length} active context${contexts.length === 1 ? '' : 's'} ` +
      `across ${byAgent.size} agent${byAgent.size === 1 ? '' : 's'} (${breakdown})`
    : args.agent
      ? `No active contexts for ${args.agent}.`
      : 'No active contexts.';

  log({
    event: 'mcp_tool_call',
    message: `list_contexts (${contexts.length} contexts)`,
  });

  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: { contexts },
  };
}
