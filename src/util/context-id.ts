import crypto from 'node:crypto';

/**
 * Context ID minting + validation.
 *
 * Format: literal "ctx_" prefix + exactly 8 chars from a Crockford-style
 * alphabet (no 0/o/i/l/1 to keep IDs unambiguous in logs / CLI).
 *
 * Spec note: the spec gave the literal alphabet
 *   "abcdefghjkmnpqrstuvwxyz23456789"
 * which is 31 symbols, not 32. We honor the spec's alphabet exactly and use
 * rejection sampling on 5-bit chunks (any value >= 31 is rejected and we
 * draw fresh entropy). This keeps the distribution uniform at the cost of
 * occasional re-rolls (~3% reject rate per chunk).
 *
 * 8 chars over 31 symbols ≈ log2(31^8) ≈ 39.6 bits of entropy. Plenty for
 * collision resistance in per-user contexts.
 */

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const ALPHABET_LEN = ALPHABET.length;
// Sanity: spec-given alphabet is 31 chars. If someone edits it, keep length
// in (1, 32] so the rejection-sampling logic below remains valid.
if (ALPHABET_LEN < 2 || ALPHABET_LEN > 32) {
  throw new Error(
    `context-id alphabet length must be in [2, 32], got ${ALPHABET_LEN}`
  );
}

const ID_LEN = 8;
const CONTEXT_ID_REGEX = new RegExp(`^ctx_[${ALPHABET}]{${ID_LEN}}$`);

/**
 * Pull one alphabet-index using rejection sampling on 5-bit chunks of a
 * cryptographically-secure byte stream. Caller-provided byte buffer is
 * consumed; if exhausted we draw more.
 */
function nextIndex(state: { buf: Uint8Array; bitPos: number }): number {
  // Loop until we get a 5-bit value < ALPHABET_LEN.
  // Worst-case probability of success per draw: ALPHABET_LEN / 32.
  // For ALPHABET_LEN = 31, that's 31/32 ≈ 96.9%.
  while (true) {
    // Ensure at least 5 bits remain.
    if (state.bitPos + 5 > state.buf.length * 8) {
      state.buf = crypto.randomBytes(8);
      state.bitPos = 0;
    }
    const byteIdx = Math.floor(state.bitPos / 8);
    const bitOff = state.bitPos % 8;
    // Read up to 5 bits straddling at most 2 bytes.
    const hi = state.buf[byteIdx]!;
    const lo = state.buf[byteIdx + 1] ?? 0;
    const combined = (hi << 8) | lo; // 16 bits, MSB-aligned for byteIdx
    const shift = 16 - bitOff - 5;
    const v = (combined >> shift) & 0b11111;
    state.bitPos += 5;
    if (v < ALPHABET_LEN) return v;
    // else: reject, redraw 5 more bits
  }
}

/** Crockford-style base32, no 0/o/i/l/1. Returns "ctx_xxxxxxxx". */
export function mintContextId(): string {
  const state = { buf: crypto.randomBytes(8), bitPos: 0 };
  let body = '';
  for (let i = 0; i < ID_LEN; i++) {
    body += ALPHABET[nextIndex(state)];
  }
  return `ctx_${body}`;
}

/** Cheap shape check — does NOT verify a context exists on disk. */
export function isContextId(s: string): boolean {
  return CONTEXT_ID_REGEX.test(s);
}
