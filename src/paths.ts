import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * Path helpers for the ~/.crewmate mailbox tree.
 *
 * Layout:
 *   ~/.crewmate/
 *     log.jsonl
 *     <agent>/
 *       agent-card.json
 *       config.json
 *       inbox/<taskId>.task.json
 *       outbox/<taskId>.result.json
 *       cancel/<taskId>
 *       workers/<pid>/<taskId>.task.json
 *       processed/<taskId>.task.json
 *       logs/<taskId>.{stdout,stderr}.log
 */

export function homeDir(): string {
  // Allow override for tests / sandboxed runs
  const override = process.env.CREWMATE_HOME;
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), '.crewmate');
}

export function logFile(): string {
  return path.join(homeDir(), 'log.jsonl');
}

export function agentDir(name: string): string {
  return path.join(homeDir(), name);
}

export function agentCardFile(name: string): string {
  return path.join(agentDir(name), 'agent-card.json');
}

export function agentConfigFile(name: string): string {
  return path.join(agentDir(name), 'config.json');
}

export function inboxDir(name: string): string {
  return path.join(agentDir(name), 'inbox');
}

export function outboxDir(name: string): string {
  return path.join(agentDir(name), 'outbox');
}

export function cancelDir(name: string): string {
  return path.join(agentDir(name), 'cancel');
}

export function workersDir(name: string): string {
  return path.join(agentDir(name), 'workers');
}

export function workerDir(name: string, pid: number | string): string {
  return path.join(workersDir(name), String(pid));
}

export function processedDir(name: string): string {
  return path.join(agentDir(name), 'processed');
}

export function logsDir(name: string): string {
  return path.join(agentDir(name), 'logs');
}

export function inboxTaskPath(name: string, taskId: string): string {
  return path.join(inboxDir(name), `${taskId}.task.json`);
}

export function outboxResultPath(name: string, taskId: string): string {
  return path.join(outboxDir(name), `${taskId}.result.json`);
}

export function cancelSentinelPath(name: string, taskId: string): string {
  return path.join(cancelDir(name), taskId);
}

export function workerTaskPath(
  name: string,
  pid: number | string,
  taskId: string
): string {
  return path.join(workerDir(name, pid), `${taskId}.task.json`);
}

export function processedTaskPath(name: string, taskId: string): string {
  return path.join(processedDir(name), `${taskId}.task.json`);
}

export function stdoutLogPath(name: string, taskId: string): string {
  return path.join(logsDir(name), `${taskId}.stdout.log`);
}

export function stderrLogPath(name: string, taskId: string): string {
  return path.join(logsDir(name), `${taskId}.stderr.log`);
}

/** Ensure all standard subdirs for an agent exist. */
export async function ensureAgentTree(name: string): Promise<void> {
  await fs.mkdir(agentDir(name), { recursive: true });
  await Promise.all([
    fs.mkdir(inboxDir(name), { recursive: true }),
    fs.mkdir(outboxDir(name), { recursive: true }),
    fs.mkdir(cancelDir(name), { recursive: true }),
    fs.mkdir(workersDir(name), { recursive: true }),
    fs.mkdir(processedDir(name), { recursive: true }),
    fs.mkdir(logsDir(name), { recursive: true }),
  ]);
  // v1.1: contexts/ + affinity/ now part of the standard agent tree.
  await ensureContextsTree(name);
}

/** Ensure the top-level ~/.crewmate dir exists. */
export async function ensureHome(): Promise<void> {
  await fs.mkdir(homeDir(), { recursive: true });
}

/** List all known agent directory names (anything under ~/.crewmate that's a dir). */
export async function listAgentNames(): Promise<string[]> {
  const root = homeDir();
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

// ─── v1.1 context paths ──────────────────────────────────────────────────────
//
// Layout under ~/.crewmate/<agent>/:
//   contexts/<contextId>/meta.json
//   contexts/<contextId>/turn_NNN.json
//   contexts/.archived/<contextId>/        (post-TTL / explicit archive)
//   affinity/<contextId>                   (worker-PID claim sentinel)

export function contextsRoot(name: string): string {
  return path.join(agentDir(name), 'contexts');
}

export function contextDir(name: string, contextId: string): string {
  return path.join(contextsRoot(name), contextId);
}

export function contextMetaFile(name: string, contextId: string): string {
  return path.join(contextDir(name, contextId), 'meta.json');
}

/** Turn files are zero-padded to 3 digits: turn_001.json, turn_042.json, … */
export function contextTurnFile(
  name: string,
  contextId: string,
  turnNumber: number
): string {
  if (!Number.isInteger(turnNumber) || turnNumber < 1) {
    throw new Error(`turnNumber must be a positive integer, got ${turnNumber}`);
  }
  const padded = String(turnNumber).padStart(3, '0');
  return path.join(contextDir(name, contextId), `turn_${padded}.json`);
}

export function archivedContextsRoot(name: string): string {
  // Lives under contexts/.archived so a single rename moves an active
  // context into archived state without crossing filesystems.
  return path.join(contextsRoot(name), '.archived');
}

export function archivedContextDir(name: string, contextId: string): string {
  return path.join(archivedContextsRoot(name), contextId);
}

export function affinityRoot(name: string): string {
  return path.join(agentDir(name), 'affinity');
}

export function affinityFile(name: string, contextId: string): string {
  return path.join(affinityRoot(name), contextId);
}

/** Ensure contexts/, contexts/.archived/, and affinity/ exist for an agent. */
export async function ensureContextsTree(name: string): Promise<void> {
  await fs.mkdir(agentDir(name), { recursive: true });
  await Promise.all([
    fs.mkdir(contextsRoot(name), { recursive: true }),
    fs.mkdir(archivedContextsRoot(name), { recursive: true }),
    fs.mkdir(affinityRoot(name), { recursive: true }),
  ]);
}
