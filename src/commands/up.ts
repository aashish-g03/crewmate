import { runSupervisor } from '../supervisor.ts';
import { loadAgentCard } from '../transports/mailbox.ts';
import { binaryName, isBinaryAvailable } from '../util/binary.ts';
import { probeAll } from './doctor.ts';

interface UpOpts {
  workers?: number;
  all?: boolean;
}

async function preflight(agent: string): Promise<void> {
  const card = await loadAgentCard(agent);
  const bin = binaryName(card);
  const ready = await isBinaryAvailable(bin);
  if (!ready) {
    process.stderr.write(
      `[crewmate] cannot start ${agent}: binary '${bin}' not found in PATH.\n` +
        `[crewmate] install ${bin} first, or remove ~/.crewmate/${agent}/ to drop the agent.\n`
    );
    process.exit(2);
  }
}

export async function cmdUp(
  agent: string | undefined,
  opts: UpOpts = {}
): Promise<void> {
  if (opts.all) {
    const rows = await probeAll();
    const ready = rows.filter((r) => r.ready);
    if (ready.length === 0) {
      process.stderr.write(
        '[crewmate] no ready agents. Run `crewmate doctor` for details.\n'
      );
      process.exit(2);
    }
    process.stderr.write(
      `[crewmate] starting ${ready.length} pool(s) in parallel: ${ready.map((r) => r.name).join(', ')}\n`
    );
    // Each runSupervisor blocks forever; run all concurrently.
    await Promise.all(
      ready.map((r) => runSupervisor(r.name, { workersOverride: opts.workers }))
    );
    return;
  }

  if (!agent) {
    process.stderr.write('Usage: crewmate up <agent> | crewmate up --all\n');
    process.exit(2);
  }
  await preflight(agent);
  await runSupervisor(agent, { workersOverride: opts.workers });
}
