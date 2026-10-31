// One writer per workspace: <stateDir>/writer.lock holds the writer job's id (exclusive create).
import fs from 'node:fs';
import path from 'node:path';
import { readJob } from './jobs.mjs';
import { isFinal } from './liveness.mjs';

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

/** @param {string} p @param {string} jobId */
function tryCreate(p, jobId) {
  try {
    const fd = fs.openSync(p, 'wx');
    fs.writeSync(fd, jobId);
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
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
  for (let attempt = 0; attempt < 2; attempt++) {
    if (tryCreate(p, jobId)) {
      return readHolder(p) === jobId ? { ok: true } : { ok: false, holder: readHolder(p) ?? 'unknown' };
    }
    const holder = readHolder(p);
    if (holder === null) continue; // removed between our create and read: retry
    const job = readJob(ws, holder);
    if (job === null) {
      let ageMs = Infinity;
      try {
        ageMs = Date.now() - fs.statSync(p).mtimeMs;
      } catch {}
      const grace = Number(env.CREWMATE_SPAWN_GRACE_MS ?? 10_000);
      if (ageMs < grace) return { ok: false, holder }; // its job record is about to be written
    } else if (!isFinal(job)) {
      return { ok: false, holder };
    }
    // Holder is final or dead: remove the lock only if it still names that holder, then retry once.
    if (readHolder(p) === holder) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }
  }
  return { ok: false, holder: readHolder(p) ?? 'unknown' };
}

/** @param {import('./workspace.mjs').Workspace} ws @param {string} jobId */
export function releaseWriter(ws, jobId) {
  const p = lockPath(ws);
  if (readHolder(p) === jobId) {
    try {
      fs.unlinkSync(p);
    } catch {}
  }
}
