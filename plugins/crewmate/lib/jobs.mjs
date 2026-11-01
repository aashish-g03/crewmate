// Job records: one folder per job under <stateDir>/jobs/<id>/, no shared index.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {{pid: number, startTime: string}} ProcRef
 * @typedef {{write?: boolean, yolo?: boolean, model?: string|null, effort?: string|null,
 *            timeoutMs?: number, resumeConversationId?: string|null}} JobFlags
 * @typedef {{exitCode: number|null, deniedTools: string[], toolErrors: string[],
 *            usage: {input: number, output: number}|null, answerBytes: number}} Outcome
 * @typedef {{id: string, vendor: 'codex'|'gemini', kind: 'ask'|'critique', promptSummary: string,
 *            flags: JobFlags, state: string, reason: string|null, createdAt: string,
 *            startedAt: string|null, endedAt: string|null, runner: ProcRef|null,
 *            vendorProcess: ProcRef|null, vendorConversationId: string|null,
 *            outcome: Outcome|null, cwd?: string}} Job
 * @typedef {import('./workspace.mjs').Workspace} Workspace
 */

export const FINAL_STATES = ['done', 'failed', 'timeout', 'canceled'];

/** @param {string} vendor */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** @param {string} vendor */
export function newJobId(vendor) {
  const bytes = crypto.randomBytes(4);
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b % ALPHABET.length];
  return `${vendor}-${Date.now().toString(36)}-${rand}`;
}

/** @param {Workspace} ws */
export function jobsRoot(ws) {
  return path.join(ws.stateDir, 'jobs');
}

/** @param {Workspace} ws @param {string} id */
export function jobDir(ws, id) {
  return path.join(jobsRoot(ws), id);
}

/**
 * Create the job folder and write job.json with state `queued`.
 * @param {Workspace} ws
 * @param {{vendor: string, kind: string, promptSummary: string, flags: JobFlags, cwd?: string}} fields
 * @param {(vendor: string) => string} [makeId]
 * @returns {Job}
 */
export function createJob(ws, fields, makeId = newJobId) {
  ensurePrivateDirs(ws);
  let id;
  for (let attempt = 0; ; attempt++) {
    id = makeId(fields.vendor);
    try {
      fs.mkdirSync(jobDir(ws, id), { mode: 0o700 }); // not recursive: an existing folder means an id collision
      break;
    } catch (err) {
      if (err.code !== 'EEXIST' || attempt >= 5) throw err;
    }
  }
  /** @type {Job} */
  const job = {
    id,
    vendor: /** @type {any} */ (fields.vendor),
    kind: /** @type {any} */ (fields.kind),
    promptSummary: fields.promptSummary,
    flags: fields.flags,
    state: 'queued',
    reason: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    runner: null,
    vendorProcess: null,
    vendorConversationId: null,
    outcome: null,
    cwd: fields.cwd,
  };
  writeJob(ws, job);
  return job;
}

/**
 * Prompts and answers can contain code: keep ~/.crewmate and everything under it user-only.
 * @param {Workspace} ws
 */
export function ensurePrivateDirs(ws) {
  const crewRoot = path.dirname(path.dirname(ws.stateDir)); // …/.crewmate
  for (const d of [crewRoot, path.dirname(ws.stateDir), ws.stateDir, jobsRoot(ws)]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(d, 0o700);
    } catch {}
  }
}

/** Atomic write: job.json.tmp then rename. @param {Workspace} ws @param {Job} job */
export function writeJob(ws, job) {
  const dir = jobDir(ws, job.id);
  const tmp = path.join(dir, `job.json.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
  fs.renameSync(tmp, path.join(dir, 'job.json'));
}

/** @param {Workspace} ws @param {string} id @returns {Job|null} */
export function readJob(ws, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(jobDir(ws, id), 'job.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Newest first by createdAt. @param {Workspace} ws @returns {Job[]} */
export function listJobs(ws) {
  let names = [];
  try {
    names = fs.readdirSync(jobsRoot(ws));
  } catch {
    return [];
  }
  const jobs = [];
  for (const name of names) {
    const job = readJob(ws, name);
    if (job) jobs.push(job);
  }
  return jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/**
 * Delete finished jobs beyond the newest `keep`; never running jobs, never the writer-lock holder.
 * @param {Workspace} ws
 * @param {(job: Job) => boolean} isFinal
 * @param {number} [keep]
 * @returns {string[]} removed ids
 */
export function pruneJobs(ws, isFinal, keep = 50) {
  let lockHolder = null;
  try {
    lockHolder = fs.readFileSync(path.join(ws.stateDir, 'writer.lock'), 'utf8').trim();
  } catch {}
  const finished = listJobs(ws).filter(isFinal);
  const removed = [];
  for (const job of finished.slice(keep)) {
    if (job.id === lockHolder) continue;
    fs.rmSync(jobDir(ws, job.id), { recursive: true, force: true });
    removed.push(job.id);
  }
  return removed;
}
