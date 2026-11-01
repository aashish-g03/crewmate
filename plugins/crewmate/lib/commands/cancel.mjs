// `crewmate cancel <id> [--json]`: stop a running job; never signal a process whose start time differs.
import { parseArgs } from '../vendored/args.mjs';
import { UsageError, assertName } from '../names.mjs';
import { resolveWorkspace } from '../workspace.mjs';
import { readJob, writeJob, jobDir } from '../jobs.mjs';
import { appendEndEvent } from '../events.mjs';
import { effectiveState, isAlive } from '../liveness.mjs';

const FINAL = ['done', 'failed', 'timeout', 'canceled'];

/** @param {number} pid @param {string} sig @param {boolean} group */
function signal(pid, sig, group) {
  try {
    process.kill(group ? -pid : pid, sig);
  } catch {}
}

/** @param {string[]} argv @param {any} io */
export async function run(argv, io) {
  const { options, positionals } = parseArgs(argv, { booleanOptions: ['json'] });
  if (!positionals[0]) throw new UsageError('usage: crewmate cancel <id>');
  const ws = resolveWorkspace(io.cwd, io.env);
  const id = assertName('job', positionals[0]);
  let job = readJob(ws, id);
  if (!job) {
    io.stderr.write(`crewmate: no such job: ${id}\n`);
    return 2;
  }
  const print = (state, prefix = '') => {
    io.stdout.write(options.json ? `${JSON.stringify({ id, state })}\n` : `${prefix}${state}\n`);
    return 0;
  };
  const grace = Number(io.env.CREWMATE_CANCEL_GRACE_MS ?? 5000);

  // Queued with no runner yet: wait briefly for it; if none appears, mark it canceled so a late
  // runner sees a final state and exits without starting the vendor.
  if (job.state === 'queued' && !job.runner) {
    const spawnGrace = Number(io.env.CREWMATE_SPAWN_GRACE_MS ?? 10_000);
    const until = Date.parse(job.createdAt) + spawnGrace;
    while (Date.now() < until && !readJob(ws, id)?.runner) await new Promise((r) => setTimeout(r, 100));
    job = readJob(ws, id);
    if (!job.runner) {
      writeJob(ws, { ...job, state: 'canceled', reason: 'canceled before start', endedAt: new Date().toISOString() });
      appendEndEvent(jobDir(ws, id), { state: 'canceled', reason: 'canceled before start' });
      return print('canceled');
    }
  }

  if (isAlive(job.runner)) {
    signal(job.runner.pid, 'SIGTERM', false);
    const deadline = Date.now() + grace + 1000;
    while (Date.now() < deadline) {
      job = readJob(ws, id);
      if (FINAL.includes(job.state)) return print(job.state);
      await new Promise((r) => setTimeout(r, 100));
    }
    if (isAlive(job.runner)) signal(job.runner.pid, 'SIGKILL', false);
    if (isAlive(job.vendorProcess)) signal(job.vendorProcess.pid, 'SIGKILL', true);
    job = readJob(ws, id);
    if (!FINAL.includes(job.state)) {
      writeJob(ws, { ...job, state: 'canceled', reason: 'canceled (runner killed)', endedAt: new Date().toISOString() });
      appendEndEvent(jobDir(ws, id), { state: 'canceled', reason: 'canceled (runner killed)', outcome: job.outcome });
    }
    return print('canceled');
  }
  // Runner gone: clean up a vendor process (group) it left behind — SIGTERM, then SIGKILL.
  if (isAlive(job.vendorProcess)) {
    const vp = job.vendorProcess;
    signal(vp.pid, 'SIGTERM', true);
    const until = Date.now() + grace;
    while (Date.now() < until && isAlive(vp)) await new Promise((r) => setTimeout(r, 100));
    signal(vp.pid, 'SIGKILL', true);
  }
  const eff = effectiveState(job);
  return print(eff.state, 'already ');
}
