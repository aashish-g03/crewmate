// `crewmate status [id] [--json]`.
import { parseArgs } from '../vendored/args.mjs';
import { assertName } from '../names.mjs';
import { resolveWorkspace } from '../workspace.mjs';
import { listJobs, readJob } from '../jobs.mjs';
import { effectiveState } from '../liveness.mjs';

/** Job record with its effective state. @param {any} job */
export function withEffective(job) {
  const eff = effectiveState(job);
  return { ...job, state: eff.state, reason: eff.reason };
}

/** @param {number} ms */
function age(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** @param {string[]} argv @param {any} io */
export async function run(argv, io) {
  const { options, positionals } = parseArgs(argv, { booleanOptions: ['json'] });
  const ws = resolveWorkspace(io.cwd, io.env);
  if (positionals[0]) {
    const job = readJob(ws, assertName('job', positionals[0]));
    if (!job) {
      io.stderr.write(`crewmate: no such job: ${positionals[0]}\n`);
      return 2;
    }
    const full = withEffective(job);
    io.stdout.write(options.json ? `${JSON.stringify(full)}\n` : `${JSON.stringify(full, null, 2)}\n`);
    return 0;
  }
  const rows = listJobs(ws).map((j) => {
    const e = withEffective(j);
    return {
      id: e.id,
      vendor: e.vendor,
      kind: e.kind,
      state: e.state,
      reason: e.reason,
      createdAt: e.createdAt,
      endedAt: e.endedAt,
      promptSummary: e.promptSummary,
      write: Boolean(e.flags?.write || e.flags?.yolo),
    };
  });
  if (options.json) {
    io.stdout.write(`${JSON.stringify(rows)}\n`);
    return 0;
  }
  if (!rows.length) {
    io.stdout.write('no jobs in this workspace\n');
    return 0;
  }
  const now = Date.now();
  for (const r of rows) {
    io.stdout.write(`${r.id}  ${r.vendor.padEnd(6)}  ${r.kind.padEnd(8)}  ${r.state.padEnd(8)}  ${age(now - Date.parse(r.createdAt)).padStart(4)}  ${r.write ? 'write ' : ''}${r.promptSummary}\n`);
  }
  return 0;
}
