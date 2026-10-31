// Is a recorded process still the same process? pid plus start time (guards against pid reuse).
import { spawnSync } from 'node:child_process';
import { FINAL_STATES } from './jobs.mjs';

/**
 * @param {number} pid
 * @returns {string|null}
 */
export function processStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  // Fixed TZ and locale: the runner records this string and other processes compare it.
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
  });
  if (r.status !== 0) return null;
  const out = r.stdout.trim();
  return out || null;
}

/**
 * @param {{pid: number, startTime: string}|null|undefined} proc
 * @returns {boolean}
 */
export function isAlive(proc) {
  if (!proc || !proc.startTime) return false;
  return processStartTime(proc.pid) === proc.startTime;
}

/**
 * @param {{state: string, reason?: string|null, createdAt: string, runner: any}} job
 * @param {number} [now]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{state: string, reason: string|null}}
 */
export function effectiveState(job, now = Date.now(), env = process.env) {
  const reason = job.reason ?? null;
  if (FINAL_STATES.includes(job.state)) return { state: job.state, reason };
  if (job.state === 'queued' && !job.runner) {
    const grace = Number(env.CREWMATE_SPAWN_GRACE_MS ?? 10_000);
    if (now - Date.parse(job.createdAt) < grace) return { state: 'queued', reason };
    return { state: 'failed', reason: 'runner never started' };
  }
  if (!isAlive(job.runner)) return { state: 'failed', reason: 'runner died' };
  return { state: job.state, reason };
}

/** @param {any} job */
export function isFinal(job) {
  return FINAL_STATES.includes(effectiveState(job).state);
}

/** Final, and no live vendor process left that only this record can find. @param {any} job */
export function isPrunable(job) {
  return isFinal(job) && !isAlive(job.vendorProcess);
}
