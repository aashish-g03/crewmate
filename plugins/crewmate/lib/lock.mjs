// One writer per workspace: <stateDir>/writer.lock holds the writer job's id (exclusive create).
import fs from 'node:fs';
import path from 'node:path';
import { readJob, jobDir } from './jobs.mjs';
import { isPrunable } from './liveness.mjs';

/** Test-only: widen race windows (CREWMATE_LOCK_TEST_PAUSE_MS). @param {NodeJS.ProcessEnv} env */
function testPause(env) {
  const ms = Number(env.CREWMATE_LOCK_TEST_PAUSE_MS ?? 0);
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** @param {import('./workspace.mjs').Workspace} ws */
function lockPath(ws) {
  return path.join(ws.stateDir, 'writer.lock');
}

/** @param {string} p */
function readHolder(p) {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Create the lock with its content in one step: write a temp file, then hard-link it into place
 * (link fails with EEXIST if the lock exists), so no reader ever sees an empty lock.
 * @param {string} p @param {string} jobId
 */
function tryCreate(p, jobId) {
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, jobId);
  try {
    fs.linkSync(tmp, p);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

const MUTEX_WAIT_MS = 3000; // CREWMATE_MUTEX_WAIT_MS overrides (tests)
const MUTEX_STALE_MS = 5000;

/** Synchronous sleep (acquireWriter is synchronous). @param {number} ms */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

class MutexBusy extends Error {}

/**
 * A short-lived mutex around the check → unlink → create sequence, so two callers reclaiming the
 * same stale lock cannot both succeed (one could otherwise delete the other's fresh lock).
 * @param {string} p lock path @param {() => any} fn
 */
function withMutex(p, fn, env = process.env) {
  const m = `${p}.mutex`;
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const until = Date.now() + Number(env.CREWMATE_MUTEX_WAIT_MS ?? MUTEX_WAIT_MS);
  for (;;) {
    if (tryCreate(m, token)) break;
    try {
      if (Date.now() - fs.statSync(m).mtimeMs > MUTEX_STALE_MS) fs.unlinkSync(m); // holder crashed
    } catch {}
    if (Date.now() > until) throw new MutexBusy();
    sleepSync(20);
  }
  try {
    return fn();
  } finally {
    if (readHolder(m) === token) {
      try {
        fs.unlinkSync(m);
      } catch {}
    }
  }
}

/**
 * @param {import('./workspace.mjs').Workspace} ws
 * @param {string} jobId
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ok: true} | {ok: false, holder: string}}
 */
export function acquireWriter(ws, jobId, env = process.env) {
  fs.mkdirSync(ws.stateDir, { recursive: true });
  const p = lockPath(ws);
  try {
    return withMutex(p, () => acquireLocked(ws, p, jobId, env), env);
  } catch (err) {
    if (err instanceof MutexBusy) return { ok: false, holder: readHolder(p) ?? 'unknown (lock busy)' };
    throw err;
  }
}

/** The body of acquireWriter; runs under the mutex. */
function acquireLocked(ws, p, jobId, env) {
  {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (tryCreate(p, jobId)) {
        return readHolder(p) === jobId ? { ok: true } : { ok: false, holder: readHolder(p) ?? 'unknown' };
      }
      const holder = readHolder(p);
      if (holder === null) continue; // removed between our create and read: retry
      const job = readJob(ws, holder);
      if (job === null) {
        // A job folder that exists but cannot be read is not proof the writer is gone.
        if (fs.existsSync(jobDir(ws, holder))) return { ok: false, holder };
        let ageMs = Infinity;
        try {
          ageMs = Date.now() - fs.statSync(p).mtimeMs;
        } catch {}
        const grace = Number(env.CREWMATE_SPAWN_GRACE_MS ?? 10_000);
        if (ageMs < grace) return { ok: false, holder }; // its job record is about to be written
      } else if (!isPrunable(job, env)) {
        return { ok: false, holder }; // still running, or its vendor process outlived its runner
      }
      // Holder is final (and its vendor is gone) or dead. Under the mutex, check and unlink cannot
      // interleave with another reclaimer.
      if (readHolder(p) === holder) {
        testPause(env);
        try {
          fs.unlinkSync(p);
        } catch {}
      }
    }
    return { ok: false, holder: readHolder(p) ?? 'unknown' };
  }
}

/** @param {import('./workspace.mjs').Workspace} ws @param {string} jobId */
export function releaseWriter(ws, jobId) {
  const p = lockPath(ws);
  const release = () => {
    if (readHolder(p) === jobId) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }
  };
  // Under the mutex, so a reclaimer cannot replace the lock between our read and our unlink.
  try {
    withMutex(p, release);
  } catch (err) {
    if (!(err instanceof MutexBusy)) throw err;
    release(); // mutex stuck: release anyway rather than leave our lock behind
  }
}
