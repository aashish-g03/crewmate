import fs from 'node:fs/promises';
import {
  inboxDir,
  outboxDir,
  workersDir,
  processedDir,
  listAgentNames,
} from '../paths.ts';

interface AgentStatus {
  agent: string;
  inbox: number;
  claimed: number;
  outbox: number;
  processed: number;
}

async function countDirEntries(dir: string): Promise<number> {
  try {
    const entries = await fs.readdir(dir);
    return entries.filter((e) => !e.startsWith('.') && !e.endsWith('.tmp')).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

async function countClaimed(agent: string): Promise<number> {
  try {
    const workerPids = await fs.readdir(workersDir(agent), { withFileTypes: true });
    let total = 0;
    for (const ent of workerPids) {
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

async function statusFor(agent: string): Promise<AgentStatus> {
  const [inbox, outbox, processed, claimed] = await Promise.all([
    countDirEntries(inboxDir(agent)),
    countDirEntries(outboxDir(agent)),
    countDirEntries(processedDir(agent)),
    countClaimed(agent),
  ]);
  return { agent, inbox, claimed, outbox, processed };
}

export async function cmdStatus(agent: string | undefined): Promise<void> {
  const agents = agent ? [agent] : await listAgentNames();
  if (agents.length === 0) {
    process.stderr.write('[crewmate] no agents found.\n');
    return;
  }
  const rows = await Promise.all(agents.map(statusFor));

  const wName = Math.max(5, ...rows.map((r) => r.agent.length));
  const header = `${'AGENT'.padEnd(wName)}  ${'INBOX'.padStart(6)}  ${'CLAIMED'.padStart(7)}  ${'OUTBOX'.padStart(6)}  ${'DONE'.padStart(6)}`;
  process.stdout.write(header + '\n');
  process.stdout.write('-'.repeat(header.length) + '\n');
  for (const r of rows) {
    process.stdout.write(
      `${r.agent.padEnd(wName)}  ${String(r.inbox).padStart(6)}  ${String(r.claimed).padStart(7)}  ${String(r.outbox).padStart(6)}  ${String(r.processed).padStart(6)}\n`
    );
  }
}
