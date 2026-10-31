// `crewmate cancel <id> [--json]`: stop a running job; never signal a process whose start time differs.
import { parseArgs } from '../vendored/args.mjs';
import { UsageError, assertName } from '../names.mjs';
import { resolveWorkspace } from '../workspace.mjs';
import { readJob, writeJob } from '../jobs.mjs';
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
    }
    return print('canceled');
  }
  // Runner gone: clean up a vendor process it left behind.
  if (isAlive(job.vendorProcess)) signal(job.vendorProcess.pid, 'SIGTERM', true);
  const eff = effectiveState(job);
  return print(eff.state, 'already ');
}
