// Name, vendor and duration validation shared by every command.

export class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = 2;
  }
}

export const VENDORS = /** @type {const} */ (['codex', 'gemini']);
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * @param {'vendor'|'job'} kind
 * @param {string} value
 * @returns {string}
 */
export function assertName(kind, value) {
  if (typeof value !== 'string' || !NAME_RE.test(value)) {
    throw new UsageError(`invalid ${kind} name: ${JSON.stringify(value)}`);
  }
  if (kind === 'vendor' && !VENDORS.includes(/** @type {any} */ (value))) {
    throw new UsageError(`unknown vendor "${value}" (use one of: ${VENDORS.join(', ')})`);
  }
  return value;
}

// Node timers overflow above 2^31-1 ms (about 24.8 days) and fire at once.
const MAX_TIMER_MS = 2_147_483_647;
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/**
 * Parse `<digits><ms|s|m|h>` into milliseconds.
 * @param {string} s
 * @returns {number}
 */
export function parseDuration(s) {
  const m = /^(\d+)(ms|s|m|h)$/.exec(String(s));
  if (!m) throw new UsageError(`invalid duration "${s}" (use e.g. 90s, 10m, 1h)`);
  const ms = Number(m[1]) * UNIT_MS[m[2]];
  if (ms <= 0) throw new UsageError(`duration must be positive: "${s}"`);
  if (ms > MAX_TIMER_MS) throw new UsageError(`duration "${s}" is too long (max about 596h)`);
  return ms;
}
