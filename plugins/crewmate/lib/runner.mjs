// The detached job runner (`crewmate _run <id>`). After it starts, it is the only writer of the job.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveWorkspace } from './workspace.mjs';
import { readJob, writeJob, jobDir, FINAL_STATES } from './jobs.mjs';
import { appendEvent, appendEndEvent } from './events.mjs';
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
// agy in headless mode ends its turn with an empty answer after any denied tool. Continuing the
// same conversation once with this message recovers a real answer (recorded 2026-11-01).
export const CONTINUE_AFTER_DENIAL =
  'Your last tool call was denied: this run does not allow that tool (shell commands and file edits are not available in read-only runs). Continue using only file-reading tools (read_file, list_dir, grep_search) and give your final answer now.';

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
  // A runner that starts after the spawn grace (sleep, heavy load) must not run a job that
  // status/watch already reported as never started.
  const spawnGrace = Number(env.CREWMATE_SPAWN_GRACE_MS ?? 10_000);
  if (Date.now() - Date.parse(job.createdAt) > spawnGrace) {
    writeJob(ws, { ...job, state: 'failed', reason: 'runner never started', endedAt: new Date().toISOString() });
    appendEndEvent(dir, { state: 'failed', reason: 'runner never started' });
    return Promise.resolve();
  }

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

  /** Outcome pieces carried across attempts (a continuation is a second attempt). */
  const carried = { deniedTools: [], toolErrors: [], usage: null, conversationId: null };
  let parser = adapter.createParser();
  let sawModelEvent = false;
  let ended = false;
  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null;
  let childExited = false;
  let lastStderr = '';
  let loggedBytes = 0;
  const timers = [];

  const merged = () => {
    const p = parser.finish();
    const usage =
      carried.usage && p.usage ? { input: carried.usage.input + p.usage.input, output: carried.usage.output + p.usage.output } : (p.usage ?? carried.usage);
    return {
      ...p,
      deniedTools: [...new Set([...carried.deniedTools, ...p.deniedTools])],
      toolErrors: [...carried.toolErrors, ...p.toolErrors],
      usage,
      conversationId: p.conversationId ?? carried.conversationId,
    };
  };

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
        const parsed = merged();
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

    /**
     * Start one vendor process with `args`; calls `onSettled(exitCode, signal)` once it has exited
     * and its stdout is drained.
     */
    const attempt = (args, onSettled) => {
      childExited = false;
      lastStderr = '';
      child = spawn(adapter.binary, args, {
        cwd: job.cwd && fs.existsSync(job.cwd) ? job.cwd : ws.root,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
      const me = child;
      me.on('error', (err) => {
        childExited = true;
        end('failed', `could not start ${adapter.binary}: ${/** @type {any} */ (err).code ?? err.message}`);
      });
      if (me.pid) save({ vendorProcess: { pid: me.pid, startTime: processStartTime(me.pid) } });
      me.stderr.on('data', (d) => {
        const last = String(d).split('\n').map((l) => l.trim()).filter(Boolean).pop();
        if (last) lastStderr = last.slice(0, 300);
        if (loggedBytes < LOG_CAP_BYTES) {
          process.stderr.write(d);
          loggedBytes += d.length;
          if (loggedBytes >= LOG_CAP_BYTES) process.stderr.write('\n[crewmate: vendor stderr log capped]\n');
        }
      });
      const rl = readline.createInterface({ input: me.stdout });
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
      // Settle when the process has exited and stdout is drained. A background grandchild can keep
      // stdout open after the vendor exits, so wait for the drain only briefly.
      let exitCode = /** @type {number|null|undefined} */ (undefined);
      let exitSignal = null;
      let stdoutDone = false;
      let settled = false;
      const settle = () => {
        if (settled || ended || exitCode === undefined || !stdoutDone) return;
        settled = true;
        onSettled(exitCode, exitSignal);
      };
      rl.on('close', () => {
        stdoutDone = true;
        settle();
      });
      me.on('exit', (code, sig) => {
        childExited = true;
        exitCode = code;
        exitSignal = sig;
        setTimeout(() => {
          if (!stdoutDone) {
            stdoutDone = true;
            me.stdout.destroy();
            settle();
          }
        }, STDOUT_DRAIN_MS).unref();
        settle();
      });
    };

    let continued = false;
    /** Decide the job's outcome after an attempt, or continue once after a denial. */
    const onSettled = (exitCode, exitSignal) => {
      const parsed = merged();
      if (parsed.timedOut) return end('timeout', 'agy stopped at its print timeout', exitCode);
      if (exitCode !== 0 || parsed.vendorError) {
        const why =
          parsed.vendorError ??
          (exitCode === null ? `killed by ${exitSignal}` : `exit ${exitCode}`) + (lastStderr ? `: ${lastStderr}` : parsed.lastError ? `: ${parsed.lastError}` : '');
        return end('failed', why, exitCode);
      }
      let answer = parsed.answer;
      if (answer === null) {
        try {
          answer = fs.readFileSync(resultFile, 'utf8');
        } catch {
          answer = '';
        }
      }
      if (answer.trim()) return end('done', null, exitCode);
      const denied = parsed.deniedTools;
      if (job.vendor === 'gemini' && denied.length && parsed.conversationId && !continued) {
        continued = true;
        carried.deniedTools = denied;
        carried.toolErrors = parsed.toolErrors;
        carried.usage = parsed.usage;
        carried.conversationId = parsed.conversationId;
        emit({ type: 'note', text: `continuing after denied tool (${denied.join(', ')})` });
        parser = adapter.createParser();
        const contJob = { ...job, flags: { ...job.flags, resumeConversationId: parsed.conversationId } };
        attempt(adapter.buildArgs(contJob, CONTINUE_AFTER_DENIAL, resultFile), onSettled);
        return;
      }
      end('failed', `vendor returned no answer${denied.length ? ` (denied: ${denied.join(', ')})` : ''}`, exitCode);
    };

    try {
      const startTime = processStartTime(process.pid);
      const fresh = readJob(ws, jobId); // cancel may have run while `ps` was working
      if (!fresh || FINAL_STATES.includes(fresh.state)) {
        ended = true;
        resolve(undefined);
        return;
      }
      job = fresh;
      save({ runner: { pid: process.pid, startTime }, state: 'running', startedAt: new Date().toISOString() });
      emit({ type: 'started', vendor: job.vendor, model: job.flags?.model ?? null });
      const prompt = fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8');

      timers.push(
        setTimeout(() => {
          if (!sawModelEvent) end('failed', 'vendor did not respond — run /crewmate:setup');
        }, firstEventMs),
      );
      timers.push(setTimeout(() => end('timeout', `no result within ${Math.round(timeoutMs / 1000)}s`), timeoutMs));
      attempt(adapter.buildArgs(job, prompt, resultFile), onSettled);
    } catch (err) {
      end('failed', `crewmate error: ${err?.message ?? err}`);
    }
  });
}
