import fs from 'node:fs/promises';
import {
  listAgentNames,
  inboxDir,
  workersDir,
} from '../../paths.ts';
import { loadAgentCard, loadAgentConfig } from '../../transports/mailbox.ts';
import { binaryName, isBinaryAvailable } from '../../util/binary.ts';
import { log } from '../../logger.ts';
import type { ToolReturn } from '../types.ts';

interface AgentLoad {
  /** Tasks currently sitting in inbox/ (queued, not yet claimed). */
  inboxDepth: number;
  /** Tasks currently being worked on (sum across workers/<pid>/ subdirs). */
  claimedDepth: number;
  /** Configured pool size for this agent. */
  poolSize: number;
  /**
   * Rough utilization score: (inbox + claimed) / max(poolSize, 1).
   * 0 = idle, ~1 = saturated, >1 = backlog. Orchestrators can use this for
   * "gemini pool is slammed, prefer kimi" routing without computing it.
   */
  loadFactor: number;
}

interface AgentEntry {
  name: string;
  description: string;
  model: string;
  contextWindow: number;
  strengths: string[];
  ready: boolean;
  binary: string;
  reason?: string;
  setupHint?: string;
  /** Operational state. Null when the agent's tree is unreadable. */
  load: AgentLoad | null;
}

/**
 * Count files matching a predicate in a directory (one level). Returns 0 if
 * the dir doesn't exist. Cheap — a single readdir + filter.
 */
async function countFiles(
  dir: string,
  predicate: (name: string) => boolean
): Promise<number> {
  try {
    const entries = await fs.readdir(dir);
    return entries.filter(predicate).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

/**
 * Sum task files claimed across every worker pid under workers/. Each pid is
 * its own subdir; we sum {pid}/<id>.task.json count across all of them.
 */
async function countClaimed(agentName: string): Promise<number> {
  let total = 0;
  let pidDirs: string[];
  try {
    pidDirs = await fs.readdir(workersDir(agentName));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  for (const pid of pidDirs) {
    total += await countFiles(
      `${workersDir(agentName)}/${pid}`,
      (n) => n.endsWith('.task.json')
    );
  }
  return total;
}

async function probeAgentLoad(agentName: string): Promise<AgentLoad | null> {
  try {
    const config = await loadAgentConfig(agentName);
    const inboxDepth = await countFiles(
      inboxDir(agentName),
      (n) => n.endsWith('.task.json')
    );
    const claimedDepth = await countClaimed(agentName);
    const poolSize = Math.max(config.poolSize, 1);
    const loadFactor = (inboxDepth + claimedDepth) / poolSize;
    return { inboxDepth, claimedDepth, poolSize, loadFactor };
  } catch {
    return null;
  }
}

/**
 * Mirror of `commands/doctor.ts::probeAll` minus the CLI formatting. We
 * deliberately re-implement here rather than import from `commands/` to
 * preserve the commands → core directionality (MCP is a sibling adapter
 * to the bash CLI, not a child).
 */
async function probeAll(): Promise<AgentEntry[]> {
  const names = await listAgentNames();
  const out: AgentEntry[] = [];
  for (const name of names) {
    const load = await probeAgentLoad(name);
    try {
      const card = await loadAgentCard(name);
      const bin = binaryName(card);
      const ready = await isBinaryAvailable(bin);
      out.push({
        name: card.name,
        description: card.description,
        model: card.model,
        contextWindow: card.contextWindow,
        strengths: card.strengths,
        ready,
        binary: bin,
        reason: ready ? undefined : `binary not found in PATH: ${bin}`,
        setupHint: card.setupHint,
        load,
      });
    } catch (err) {
      out.push({
        name,
        description: '',
        model: 'unknown',
        contextWindow: 0,
        strengths: [],
        ready: false,
        binary: '?',
        reason: `agent-card.json missing or invalid: ${(err as Error).message}`,
        load,
      });
    }
  }
  return out;
}

export async function handleListAgents(): Promise<ToolReturn> {
  const agents = await probeAll();
  log({ event: 'mcp_tool_call', message: `list_agents (${agents.length} agents)` });

  // Plain-text content block for clients that don't render structured output.
  const lines = agents.length
    ? agents.map((a) => {
        const status = a.ready ? 'ready' : `MISSING (${a.reason ?? 'unknown'})`;
        const load = a.load
          ? `load=${a.load.loadFactor.toFixed(2)} (${a.load.inboxDepth}+${a.load.claimedDepth}/${a.load.poolSize})`
          : 'load=?';
        return `${a.name}\t${a.model}\t${status}\t${load}`;
      })
    : ['(no agents initialized — run `crewmate init`)'];

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: { agents },
  };
}
