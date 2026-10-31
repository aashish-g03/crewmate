// Vendor adapters plus the shared PATH lookup and install hints.
import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from '../names.mjs';
import { codexAdapter } from './codex.mjs';
import { geminiAdapter } from './gemini.mjs';

/**
 * @typedef {import('../jobs.mjs').Job} Job
 * @typedef {{type: string, [k: string]: any}} VendorEvent
 * @typedef {{conversationId: string|null, answer: string|null, deniedTools: string[], toolErrors: string[],
 *            usage: {input: number, output: number}|null, vendorError: string|null, permissionMode: string|null,
 *            lastError?: string|null, timedOut?: boolean}} ParsedOutcome
 * @typedef {{feed(line: string): VendorEvent[], isModelEvent(line: string): boolean, finish(): ParsedOutcome}} Parser
 * @typedef {{binary: 'codex'|'agy', buildArgs(job: any, prompt: string, resultFile: string): string[],
 *            createParser(): Parser, expectedPermissionMode(job: any): 'request-review'|null}} Adapter
 */

export const INSTALL_TEXT = {
  codex: 'npm i -g @openai/codex',
  gemini: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
};

/** @param {string} vendor @returns {Adapter} */
export function getAdapter(vendor) {
  if (vendor === 'codex') return codexAdapter;
  if (vendor === 'gemini') return geminiAdapter;
  throw new UsageError(`unknown vendor "${vendor}"`);
}

/**
 * PATH lookup without running the binary.
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function findOnPath(name, env = process.env) {
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      if (!fs.statSync(p).isFile()) continue;
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

/** Parse a line as JSON, or return null. @param {string} line */
export function parseJson(line) {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** @param {string} s @param {number} n */
export function cut(s, n = 80) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}
