// The detached job runner (`crewmate _run <id>`). After it starts, it is the only writer of the job.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveWorkspace } from './workspace.mjs';
import { readJob, writeJob, jobDir } from './jobs.mjs';
import { appendEvent } from './events.mjs';
import { processStartTime } from './liveness.mjs';
import { releaseWriter } from './lock.mjs';
import { assertName } from './names.mjs';
import { getAdapter } from './vendors/index.mjs';

const BIN = fileURLToPath(new URL('../bin/crewmate', import.meta.url));

/**
 * Start the detached runner for a job. Does not write job.json.
 * @param {import('./workspace.mjs').Workspace} ws
 * @param {string} jobId
 * @param {NodeJS.ProcessEnv} [env]
 */
export function spawnRunner(ws, jobId, env = process.env) {
  const log = fs.openSync(path.join(jobDir(ws, jobId), 'runner.log'), 'a');
  const child = spawn(process.execPath, [BIN, '_run', jobId], {
    detached: true,
    stdio: ['ignore', log, log],
    cwd: ws.root,
    env,
  });
  child.unref();
  fs.closeSync(log);
}

/** `_run <jobId>` entry. @param {string[]} argv @param {any} io */
export async function run(argv, io) {
  const jobId = assertName('job', argv[1]);
  const ws = resolveWorkspace(io.cwd, io.env);
  await runJob(ws, jobId, io.env);
  return 0;
}

/** @param {number} pid @param {string} sig */
function killGroup(pid, sig) {
  try {
    process.kill(-pid, sig);
  } catch {}
}

/**
 * @param {import('./workspace.mjs').Workspace} ws
 * @param {string} jobId
 * @param {NodeJS.ProcessEnv} env
 */
export function runJob(ws, jobId, env) {
  const dir = jobDir(ws, jobId);
  let job = readJob(ws, jobId);
  if (!job) throw new Error(`no such job: ${jobId}`);
  const adapter = getAdapter(job.vendor);
  const prompt = fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8');
  const resultFile = path.join(dir, 'result.md');
  const grace = Number(env.CREWMATE_CANCEL_GRACE_MS ?? 5000);
  const firstEventMs = Number(env.CREWMATE_FIRST_EVENT_MS ?? 45_000);
  const expectedMode = adapter.expectedPermissionMode(job);

  let n = 0;
  const emit = (ev) => appendEvent(dir, { ...ev, n: ++n });
  const save = (patch) => {
    job = { ...job, ...patch };
    writeJob(ws, job);
  };

  save({
    runner: { pid: process.pid, startTime: processStartTime(process.pid) },
    state: 'running',
    startedAt: new Date().toISOString(),
  });
  emit({ type: 'started', vendor: job.vendor, model: job.flags?.model ?? null });

  const parser = adapter.createParser();
  let sawModelEvent = false;
  let ended = false;
  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null;
  let childExited = false;
  const timers = [];

  return new Promise((resolve) => {
    /** @param {string} state @param {string|null} reason @param {number|null} exitCode */
    const end = async (state, reason, exitCode = null) => {
      if (ended) return;
      ended = true;
      for (const t of timers) clearTimeout(t);
      if (child && !childExited && child.pid) {
        killGroup(child.pid, 'SIGTERM');
        const exited = await new Promise((r) => {
          const t = setTimeout(() => r(false), grace);
          child.once('exit', () => {
            clearTimeout(t);
            r(true);
          });
        });
        if (!exited) killGroup(child.pid, 'SIGKILL');
      }
      const parsed = parser.finish();
      let answer = parsed.answer;
      if (answer === null) {
        try {
          answer = fs.readFileSync(resultFile, 'utf8');
        } catch {
          answer = '';
        }
      } else {
        fs.writeFileSync(resultFile, answer);
      }
      const outcome = {
        exitCode,
        deniedTools: parsed.deniedTools,
        toolErrors: parsed.toolErrors,
        usage: parsed.usage,
        answerBytes: Buffer.byteLength(answer ?? ''),
      };
      save({ state, reason, endedAt: new Date().toISOString(), outcome, vendorConversationId: parsed.conversationId ?? job.vendorConversationId });
      emit({ type: 'end', state, reason, outcome });
      if (job.flags?.write || job.flags?.yolo) releaseWriter(ws, jobId);
      resolve(undefined);
    };

    process.once('SIGTERM', () => end('canceled', 'canceled'));

    try {
      child = spawn(adapter.binary, adapter.buildArgs(job, prompt, resultFile), {
        cwd: ws.root,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
    } catch (err) {
      end('failed', `could not start ${adapter.binary}: ${err.code ?? err.message}`);
      return;
    }
    child.on('error', (err) => {
      childExited = true;
      end('failed', `could not start ${adapter.binary}: ${/** @type {any} */ (err).code ?? err.message}`);
    });
    if (child.pid) save({ vendorProcess: { pid: child.pid, startTime: processStartTime(child.pid) } });
    child.stderr.on('data', (d) => process.stderr.write(d));

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (ended) return;
      if (parser.isModelEvent(line)) sawModelEvent = true;
      for (const ev of parser.feed(line)) emit(ev);
      const mode = parser.finish().permissionMode;
      if (expectedMode && mode && mode !== expectedMode) {
        end('failed', `agy permission mode is ${mode}, expected ${expectedMode} (check your agy settings)`);
      }
    });

    timers.push(
      setTimeout(() => {
        if (!sawModelEvent) end('failed', `vendor did not respond — run /crewmate:setup`);
      }, firstEventMs),
    );
    timers.push(setTimeout(() => end('timeout', `no result within ${Math.round((job.flags?.timeoutMs ?? 600_000) / 1000)}s`), job.flags?.timeoutMs ?? 600_000));

    // Decide only after BOTH the process has exited and readline has delivered every line:
    // the child's 'close' can fire before readline emits its last buffered lines.
    let exitCode = /** @type {number|null|undefined} */ (undefined);
    let stdoutDone = false;
    const settle = () => {
      if (ended || exitCode === undefined || !stdoutDone) return;
      const code = exitCode;
      const parsed = parser.finish();
      if (code !== 0 || parsed.vendorError) {
        end('failed', parsed.vendorError ?? `exit ${code}`, code);
        return;
      }
      let answer = parsed.answer;
      if (answer === null) {
        try {
          answer = fs.readFileSync(resultFile, 'utf8');
        } catch {
          answer = '';
        }
      }
      if (!answer.trim()) end('failed', 'vendor returned no answer', code);
      else end('done', null, code);
    };
    rl.on('close', () => {
      stdoutDone = true;
      settle();
    });
    child.on('exit', (code, sig) => {
      childExited = true;
      exitCode = code ?? (sig ? 128 : null);
      settle();
    });
  });
}
