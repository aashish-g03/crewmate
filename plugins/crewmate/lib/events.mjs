// Append-only job event log: <jobDir>/events.ndjson. The runner is the only writer and owns `n`.
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {{n: number, t?: string, type: 'started'|'tool'|'note'|'usage'|'end', [k: string]: any}} Event
 */

const NOTE_MAX = 200;

/** @param {string} dir */
function file(dir) {
  return path.join(dir, 'events.ndjson');
}

/**
 * @param {string} dir
 * @param {Event} ev  caller supplies `n`
 */
export function appendEvent(dir, ev) {
  /** @type {Record<string, any>} */
  const out = { ...ev, t: new Date().toISOString() };
  if (out.type === 'note' && typeof out.text === 'string' && out.text.length > NOTE_MAX) {
    out.text = `${out.text.slice(0, NOTE_MAX - 1)}…`;
  }
  fs.appendFileSync(file(dir), `${JSON.stringify(out)}\n`);
}

/**
 * Append an `end` event after whatever is already in the log (for writers other than the runner,
 * e.g. `cancel` marking a job it had to kill or that never started).
 * @param {string} dir @param {{state: string, reason: string|null, outcome?: any}} fin
 */
export function appendEndEvent(dir, fin) {
  const last = readEvents(dir).at(-1)?.n ?? 0;
  appendEvent(dir, { n: last + 1, type: 'end', state: fin.state, reason: fin.reason, outcome: fin.outcome ?? null });
}

/**
 * Complete lines with n > sinceN. A trailing partial line is ignored.
 * @param {string} dir
 * @param {number} [sinceN]
 * @returns {Event[]}
 */
export function readEvents(dir, sinceN = 0) {
  let text;
  try {
    text = fs.readFileSync(file(dir), 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n');
  lines.pop(); // the part after the last newline is incomplete (or empty)
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.n > sinceN) out.push(ev);
    } catch {}
  }
  return out;
}
