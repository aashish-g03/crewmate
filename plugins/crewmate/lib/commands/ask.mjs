// `crewmate ask <vendor> [prompt]`: start a job, then watch it unless --detach.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from '../vendored/args.mjs';
import { UsageError, assertName, parseDuration } from '../names.mjs';
import { resolveWorkspace } from '../workspace.mjs';
import { createJob, jobDir, listJobs, pruneJobs } from '../jobs.mjs';
import { effectiveState, isPrunable } from '../liveness.mjs';
import { acquireWriter } from '../lock.mjs';
import { spawnRunner } from '../runner.mjs';
import { getAdapter, findOnPath, INSTALL_TEXT } from '../vendors/index.mjs';

export const MAX_PROMPT_BYTES = 100_000;
const DEFAULT_TIMEOUT_MS = 600_000;
const RUNNING = ['queued', 'running'];

/**
 * Take `--name=value` forms of optional-value flags out of argv before parseArgs.
 * @param {string[]} argv @param {string[]} names
 */
export function extractOptionalValues(argv, names) {
  /** @type {Record<string, string|true>} */
  const found = {};
  const rest = [];
  let passthrough = false;
  for (const tok of argv) {
    if (!passthrough && tok === '--') passthrough = true;
    const m = !passthrough && /^--([a-z-]+)(?:=(.*))?$/.exec(tok);
    if (m && names.includes(m[1])) {
      if (m[2] !== undefined && m[2] === '') throw new UsageError(`--${m[1]}= needs a value`);
      found[m[1]] = m[2] ?? true;
      continue;
    }
    rest.push(tok);
  }
  return { found, rest };
}

/**
 * Read all of piped stdin as UTF-8 (a stream read: fs.readFileSync(0) fails with EAGAIN on large pipes).
 * @param {NodeJS.ReadStream} stdin
 * @returns {Promise<string>}
 */
export async function readStdin(stdin) {
  if (!stdin || stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** @param {string} prompt */
export function summarize(prompt) {
  const first = prompt.trim().split('\n')[0] ?? '';
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

/**
 * Create, lock (if writing) and spawn one job. Returns {jobId} or {code, message}.
 * @param {import('../workspace.mjs').Workspace} ws
 * @param {{vendor: string, kind: 'ask'|'critique', prompt: string, flags: any, cwd?: string}} spec
 * @param {NodeJS.ProcessEnv} env
 */
export function launchJob(ws, spec, env) {
  pruneJobs(ws, isPrunable);
  const job = createJob(ws, { vendor: spec.vendor, kind: spec.kind, promptSummary: summarize(spec.prompt), flags: spec.flags, cwd: spec.cwd });
  fs.writeFileSync(path.join(jobDir(ws, job.id), 'prompt.txt'), spec.prompt);
  if (spec.flags.write || spec.flags.yolo) {
    const got = acquireWriter(ws, job.id, env);
    if (!got.ok) {
      fs.rmSync(jobDir(ws, job.id), { recursive: true, force: true });
      return { code: 6, message: `a write job is already running in this workspace: ${'holder' in got ? got.holder : 'unknown'}` };
    }
  }
  spawnRunner(ws, job.id, env);
  return { jobId: job.id };
}

/** @param {string} vendor @param {NodeJS.ProcessEnv} env */
export function vendorMissing(vendor, env) {
  const bin = getAdapter(vendor).binary;
  return findOnPath(bin, env) ? null : `${bin} is not on PATH. Install: ${INSTALL_TEXT[vendor]}`;
}

/** @param {string[]} argv @param {any} io */
export async function run(argv, io) {
  const { found, rest } = extractOptionalValues(argv, ['resume']);
  let parsed;
  try {
    parsed = parseArgs(rest, {
      valueOptions: ['model', 'effort', 'timeout', 'prompt-file'],
      booleanOptions: ['detach', 'write', 'yolo', 'json', 'brief'],
    });
  } catch (err) {
    throw new UsageError(err.message);
  }
  const { options, positionals } = parsed;
  const [vendorArg, ...words] = positionals;
  if (!vendorArg) throw new UsageError('usage: crewmate ask <codex|gemini> [prompt]');
  const vendor = assertName('vendor', vendorArg);
  const stray = words.find((w) => w.startsWith('--'));
  if (stray) throw new UsageError(`unknown option ${stray}`);
  const timeoutMs = options.timeout ? parseDuration(options.timeout) : DEFAULT_TIMEOUT_MS;

  let prompt = words.join(' ');
  if (!prompt.trim() && options['prompt-file']) {
    try {
      prompt = fs.readFileSync(path.resolve(io.cwd, options['prompt-file']), 'utf8');
    } catch (err) {
      throw new UsageError(`cannot read --prompt-file ${options['prompt-file']}: ${err.code ?? err.message}`);
    }
  }
  if (!prompt.trim() && !words.length && !options['prompt-file']) prompt = await readStdin(io.stdin);
  if (!prompt.trim()) throw new UsageError('empty prompt');
  if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new UsageError(`prompt too large (over ${MAX_PROMPT_BYTES} bytes)`);

  const missing = vendorMissing(vendor, io.env);
  if (missing) {
    io.stderr.write(`crewmate: ${missing}\n`);
    return 3;
  }

  const ws = resolveWorkspace(io.cwd, io.env);
  let resumeConversationId = null;
  if (found.resume !== undefined) {
    const jobs = listJobs(ws);
    const target =
      found.resume === true
        ? jobs.find((j) => j.vendor === vendor && j.kind === 'ask' && j.vendorConversationId)
        : jobs.find((j) => j.id === assertName('job', /** @type {string} */ (found.resume)));
    if (!target || !target.vendorConversationId) throw new UsageError('nothing to resume');
    if (target.vendor !== vendor) throw new UsageError(`${target.id} is a ${target.vendor} job; resume it with: crewmate ask ${target.vendor} --resume=${target.id}`);
    const busy = jobs.find((j) => j.vendor === vendor && RUNNING.includes(effectiveState(j).state));
    if (busy) {
      io.stderr.write(`crewmate: a ${vendor} job is still running: ${busy.id}\n`);
      return 6;
    }
    resumeConversationId = target.vendorConversationId;
  }

  const flags = {
    write: Boolean(options.write),
    yolo: Boolean(options.yolo),
    model: options.model ?? null,
    effort: options.effort ?? null,
    timeoutMs,
    resumeConversationId,
  };
  const res = launchJob(ws, { vendor, kind: 'ask', prompt, flags, cwd: fs.realpathSync(io.cwd) }, io.env);
  if ('code' in res) {
    io.stderr.write(`crewmate: ${res.message}\n`);
    return res.code;
  }
  if (options.detach) {
    io.stdout.write(options.json ? `${JSON.stringify({ jobId: res.jobId })}\n` : `${res.jobId}\n`);
    return 0;
  }
  const watch = await import('./watch.mjs');
  if (!options.json) {
    io.stdout.write(`${res.jobId}\n`);
    return watch.run(options.brief ? [res.jobId, '--brief'] : [res.jobId], io);
  }
  // --json in the foreground: watch silently, then print one JSON object.
  const sink = { ...io, stdout: { write: () => true } };
  const code = await watch.run([res.jobId], sink);
  const { withEffective } = await import('./status.mjs');
  const { readJob } = await import('../jobs.mjs');
  const job = withEffective(readJob(ws, res.jobId));
  let answer = '';
  try {
    answer = fs.readFileSync(path.join(jobDir(ws, res.jobId), 'result.md'), 'utf8');
  } catch {}
  io.stdout.write(`${JSON.stringify({ jobId: res.jobId, state: job.state, reason: job.reason, answer, outcome: job.outcome })}\n`);
  return code;
}
