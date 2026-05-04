import { listAgentNames } from '../paths.ts';
import { loadAgentCard } from '../transports/mailbox.ts';
import { binaryName, isBinaryAvailable } from '../util/binary.ts';
import type { AgentCard } from '../envelope.ts';

/** Print all initialized agents as a table, including readiness of the underlying CLI binary. */
export async function cmdList(): Promise<void> {
  const names = await listAgentNames();
  if (names.length === 0) {
    process.stderr.write(
      '[crewmate] no agents initialized. Run `crewmate init` first.\n'
    );
    return;
  }

  interface Row {
    name: string;
    model: string;
    transport: string;
    status: string;
    strengths: string;
  }
  const rows: Row[] = [];
  for (const name of names) {
    try {
      const card: AgentCard = await loadAgentCard(name);
      const bin = binaryName(card);
      const ready = await isBinaryAvailable(bin);
      rows.push({
        name: card.name,
        model: card.model,
        transport: card.transport ?? 'spawn',
        status: ready ? 'ready' : `missing(${bin})`,
        strengths: card.strengths.join(', '),
      });
    } catch {
      // Directory exists but no/invalid card — skip silently.
    }
  }

  if (rows.length === 0) {
    process.stderr.write('[crewmate] no valid agent cards found.\n');
    return;
  }

  const wName = Math.max(4, ...rows.map((r) => r.name.length));
  const wModel = Math.max(5, ...rows.map((r) => r.model.length));
  const wTrans = Math.max(9, ...rows.map((r) => r.transport.length));
  const wStatus = Math.max(6, ...rows.map((r) => r.status.length));
  const wStr = Math.max(9, ...rows.map((r) => r.strengths.length));

  const sep = `${'-'.repeat(wName)}  ${'-'.repeat(wModel)}  ${'-'.repeat(wTrans)}  ${'-'.repeat(wStatus)}  ${'-'.repeat(wStr)}`;
  process.stdout.write(
    `${'NAME'.padEnd(wName)}  ${'MODEL'.padEnd(wModel)}  ${'TRANSPORT'.padEnd(wTrans)}  ${'STATUS'.padEnd(wStatus)}  ${'STRENGTHS'.padEnd(wStr)}\n`
  );
  process.stdout.write(sep + '\n');
  for (const r of rows) {
    process.stdout.write(
      `${r.name.padEnd(wName)}  ${r.model.padEnd(wModel)}  ${r.transport.padEnd(wTrans)}  ${r.status.padEnd(wStatus)}  ${r.strengths.padEnd(wStr)}\n`
    );
  }
}
