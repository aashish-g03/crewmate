import { listAgentNames } from '../paths.ts';
import { loadAgentCard } from '../transports/mailbox.ts';
import { binaryName, isBinaryAvailable } from '../util/binary.ts';
import type { AgentCard } from '../envelope.ts';

/**
 * Inspect every initialized agent and report whether its underlying CLI
 * binary is callable. Drives graceful degradation: callers like `up --all`
 * and the crewmate subagent only target ready workers.
 */

interface AgentHealth {
  name: string;
  model: string;
  binary: string;
  ready: boolean;
  reason?: string;
  setupHint?: string;
}

export async function probeAll(): Promise<AgentHealth[]> {
  const names = await listAgentNames();
  const out: AgentHealth[] = [];
  for (const name of names) {
    try {
      const card: AgentCard = await loadAgentCard(name);
      const bin = binaryName(card);
      const ready = await isBinaryAvailable(bin);
      out.push({
        name: card.name,
        model: card.model,
        binary: bin,
        ready,
        reason: ready ? undefined : `binary not found in PATH: ${bin}`,
        setupHint: card.setupHint,
      });
    } catch (err) {
      out.push({
        name,
        model: 'unknown',
        binary: '?',
        ready: false,
        reason: `agent-card.json missing or invalid: ${(err as Error).message}`,
      });
    }
  }
  return out;
}

export async function cmdDoctor(opts: { json?: boolean } = {}): Promise<void> {
  const rows = await probeAll();
  if (rows.length === 0) {
    process.stderr.write(
      '[crewmate] no agents initialized. Run `crewmate init`.\n'
    );
    return;
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return;
  }

  const wName = Math.max(4, ...rows.map((r) => r.name.length));
  const wBin = Math.max(6, ...rows.map((r) => r.binary.length));

  process.stdout.write(
    `${'NAME'.padEnd(wName)}  ${'BINARY'.padEnd(wBin)}  STATUS\n`
  );
  process.stdout.write(
    `${'-'.repeat(wName)}  ${'-'.repeat(wBin)}  ------\n`
  );
  for (const r of rows) {
    const status = r.ready
      ? 'ready'
      : `MISSING (${r.reason ?? 'unknown'})`;
    process.stdout.write(
      `${r.name.padEnd(wName)}  ${r.binary.padEnd(wBin)}  ${status}\n`
    );
  }

  const hinted = rows.filter((r) => r.ready && r.setupHint);
  for (const h of hinted) {
    process.stderr.write(`[hint] ${h.name}: ${h.setupHint}\n`);
  }

  const missing = rows.filter((r) => !r.ready);
  if (missing.length > 0) {
    process.stderr.write(
      `\n[crewmate] ${missing.length} agent(s) not ready. ` +
        `Install the listed CLI(s) or remove the agent dir from ~/.crewmate to silence.\n`
    );
  }
}
