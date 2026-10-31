// The detached job runner (`crewmate _run <id>`). After it starts, it is the only writer of the job.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveWorkspace } from './workspace.mjs';
import { readJob, writeJob, jobDir, FINAL_STATES } from './jobs.mjs';
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

const STDOUT_DRAIN_MS = 500;
const LOG_CAP_BYTES = 1_000_000;

/**
 * Run one job to a final state. Exactly one `end` event and one final state on every path.
 * @param {import('./workspace.mjs').Workspace} ws
 * @param {string} jobId
 * @param {NodeJS.ProcessEnv} env
 */
export function runJob(ws, jobId, env) {
  const dir = jobDir(ws, jobId);
  let job = readJob(ws, jobId);
  if (!job) throw new Error(`no such job: ${jobId}`);
  // Never restart a job that already ended (e.g. canceled before start) or already has a runner.
  if (FINAL_STATES.includes(job.state) || job.runner) return Promise.resolve();

  const adapter = getAdapter(job.vendor);
  const resultFile = path.join(dir, 'result.md');
  const grace = Number(env.CREWMATE_CANCEL_GRACE_MS ?? 5000);
  const firstEventMs = Number(env.CREWMATE_FIRST_EVENT_MS ?? 45_000);
  const timeoutMs = job.flags?.timeoutMs ?? 600_000;
  const expectedMode = adapter.expectedPermissionMode(job);

  let n = 0;
  const emit = (ev) => appendEvent(dir, { ...ev, n: ++n });
  const save = (patch) => {
    job = { ...job, ...patch };
    writeJob(ws, job);
  };

  const parser = adapter.createParser();
  let sawModelEvent = false;
  let ended = false;
  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null;
  let childExited = false;
  let lastStderr = '';
  let loggedBytes = 0;
  const timers = [];

  return new Promise((resolve) => {
    /** @param {string} state @param {string|null} reason @param {number|null} [exitCode] */
    const end = async (state, reason, exitCode = null) => {
      if (ended) return;
      ended = true;
      for (const t of timers) clearTimeout(t);
      try {
        if (child?.pid) {
          if (!childExited) {
            killGroup(child.pid, 'SIGTERM');
            await new Promise((r) => {
              const onExit = () => {
                clearTimeout(t);
                r(undefined);
              };
              const t = setTimeout(() => {
                child.removeListener('exit', onExit);
                r(undefined);
              }, grace);
              child.once('exit', onExit);
            });
          }
          // Always: leftover group members (grandchildren ignoring SIGTERM) must not outlive the job.
          killGroup(child.pid, 'SIGKILL');
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
      } catch (err) {
        process.stderr.write(`crewmate runner: failed to finish job: ${err?.stack ?? err}\n`);
      } finally {
        if (job.flags?.write || job.flags?.yolo) releaseWriter(ws, jobId);
        resolve(undefined);
      }
    };

    process.on('SIGTERM', () => end('canceled', 'canceled'));

    try {
      save({
        runner: { pid: process.pid, startTime: processStartTime(process.pid) },
        state: 'running',
        startedAt: new Date().toISOString(),
      });
      emit({ type: 'started', vendor: job.vendor, model: job.flags?.model ?? null });
      const prompt = fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8');

      child = spawn(adapter.binary, adapter.buildArgs(job, prompt, resultFile), {
        cwd: ws.root,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
      child.on('error', (err) => {
        childExited = true;
        end('failed', `could not start ${adapter.binary}: ${/** @type {any} */ (err).code ?? err.message}`);
      });
      if (child.pid) save({ vendorProcess: { pid: child.pid, startTime: processStartTime(child.pid) } });

      child.stderr.on('data', (d) => {
        const text = String(d);
        const last = text.split('\n').map((l) => l.trim()).filter(Boolean).pop();
        if (last) lastStderr = last.slice(0, 300);
        if (loggedBytes < LOG_CAP_BYTES) {
          process.stderr.write(d);
          loggedBytes += d.length;
          if (loggedBytes >= LOG_CAP_BYTES) process.stderr.write('\n[crewmate: vendor stderr log capped]\n');
        }
      });

      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        if (ended) return;
        try {
          if (parser.isModelEvent(line)) sawModelEvent = true;
          for (const ev of parser.feed(line)) emit(ev);
          const mode = parser.finish().permissionMode;
          if (expectedMode && mode && mode !== expectedMode) {
            end('failed', `agy permission mode is ${mode}, expected ${expectedMode} (check your agy settings)`);
          }
        } catch (err) {
          end('failed', `crewmate error: ${err?.message ?? err}`);
        }
      });

      timers.push(
        setTimeout(() => {
          if (!sawModelEvent) end('failed', 'vendor did not respond — run /crewmate:setup');
        }, firstEventMs),
      );
      timers.push(setTimeout(() => end('timeout', `no result within ${Math.round(timeoutMs / 1000)}s`), timeoutMs));

      // Decide when the process has exited and stdout is drained. A background grandchild can keep
      // stdout open after the vendor exits, so wait for the drain only briefly.
      let exitCode = /** @type {number|null|undefined} */ (undefined);
      let exitSignal = null;
      let stdoutDone = false;
      const settle = () => {
        if (ended || exitCode === undefined || !stdoutDone) return;
        const parsed = parser.finish();
        if (exitCode !== 0 || parsed.vendorError) {
          const why =
            parsed.vendorError ??
            (exitCode === null ? `killed by ${exitSignal}` : `exit ${exitCode}`) + (lastStderr ? `: ${lastStderr}` : parsed.lastError ? `: ${parsed.lastError}` : '');
          end('failed', why, exitCode);
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
        if (!answer.trim()) {
          const denied = parsed.deniedTools.length ? ` (denied: ${parsed.deniedTools.join(', ')})` : '';
          end('failed', `vendor returned no answer${denied}`, exitCode);
        } else end('done', null, exitCode);
      };
      rl.on('close', () => {
        stdoutDone = true;
        settle();
      });
      child.on('exit', (code, sig) => {
        childExited = true;
        exitCode = code;
        exitSignal = sig;
        setTimeout(() => {
          if (!stdoutDone) {
            stdoutDone = true;
            child.stdout.destroy();
            settle();
          }
        }, STDOUT_DRAIN_MS).unref();
        settle();
      });
    } catch (err) {
      end('failed', `crewmate error: ${err?.message ?? err}`);
    }
  });
}
