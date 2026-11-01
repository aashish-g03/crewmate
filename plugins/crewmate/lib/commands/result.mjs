// `crewmate result <id> [--json]`: the answer plus an outcome block.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from '../vendored/args.mjs';
import { UsageError, assertName } from '../names.mjs';
import { resolveWorkspace } from '../workspace.mjs';
import { readJob, jobDir } from '../jobs.mjs';
import { withEffective } from './status.mjs';

/** @param {string[]} argv @param {any} io */
export async function run(argv, io) {
  const { options, positionals } = parseArgs(argv, { booleanOptions: ['json'] });
  if (!positionals[0]) throw new UsageError('usage: crewmate result <id> [--json]');
  const ws = resolveWorkspace(io.cwd, io.env);
  const raw = readJob(ws, assertName('job', positionals[0]));
  if (!raw) {
    io.stderr.write(`crewmate: no such job: ${positionals[0]}\n`);
    return 2;
  }
  const job = withEffective(raw);
  if (job.state === 'queued' || job.state === 'running') {
    io.stderr.write(`crewmate: job still running: ${job.id} (use: crewmate watch ${job.id})\n`);
    return 2;
  }
  let answer = '';
  try {
    answer = fs.readFileSync(path.join(jobDir(ws, job.id), 'result.md'), 'utf8');
  } catch {}
  if (options.json) {
    io.stdout.write(`${JSON.stringify({ job, answer })}\n`);
    return 0;
  }
  const o = job.outcome ?? {};
  const secs = job.startedAt && job.endedAt ? Math.round((Date.parse(job.endedAt) - Date.parse(job.startedAt)) / 1000) : null;
  io.stdout.write(`${answer.trimEnd()}\n\n---\n`);
  io.stdout.write(`job: ${job.id} (${job.vendor})\nstate: ${job.state}${job.reason ? ` — ${job.reason}` : ''}\n`);
  if (secs !== null) io.stdout.write(`duration: ${secs}s\n`);
  if (o.usage) io.stdout.write(`tokens: ${o.usage.input} in / ${o.usage.output} out\n`);
  io.stdout.write(`denied tools: ${o.deniedTools?.length ? o.deniedTools.join(', ') : 'none'}\n`);
  io.stdout.write(`tool errors: ${o.toolErrors?.length ? o.toolErrors.join(' | ') : 'none'}\n`);
  return 0;
}
