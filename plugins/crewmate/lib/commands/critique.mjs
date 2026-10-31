// `crewmate critique <path...> | --diff[=<ref>]`: one read-only job per available vendor.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseArgs } from '../vendored/args.mjs';
import { ensureAbsolutePath } from '../vendored/fs.mjs';
import { collectReviewContext, resolveReviewTarget } from '../vendored/git.mjs';
import { UsageError, VENDORS, assertName } from '../names.mjs';
import { resolveWorkspace } from '../workspace.mjs';
import { extractOptionalValues, launchJob, vendorMissing, MAX_PROMPT_BYTES } from './ask.mjs';

const TEMPLATE = new URL('../critique-template.md', import.meta.url);
const TESTING_RULE = new URL('../testing-rule.md', import.meta.url);

/** @param {string} target */
export function buildCritiquePrompt(target) {
  const tpl = fs.readFileSync(TEMPLATE, 'utf8').replace(/^<!--[\s\S]*?-->\n/, '');
  // Fill the testing rule first: a diff of the template itself may contain the literal {{TESTING_RULE}}.
  return tpl.replace('{{TESTING_RULE}}', () => fs.readFileSync(TESTING_RULE, 'utf8').trim()).replace('{{TARGET}}', () => target);
}

/** @param {string[]} argv @param {any} io */
export async function run(argv, io) {
  const { found, rest } = extractOptionalValues(argv, ['diff']);
  let parsed;
  try {
    parsed = parseArgs(rest, { valueOptions: ['vendors', 'timeout'], booleanOptions: ['json'] });
  } catch (err) {
    throw new UsageError(err.message);
  }
  const { options, positionals } = parsed;
  if (!positionals.length && found.diff === undefined) throw new UsageError('nothing to critique (give file paths or --diff)');
  if (found.diff !== undefined && positionals.length) throw new UsageError('give either paths or --diff; for a ref use --diff=<ref>');
  const vendors = [...new Set((options.vendors ? String(options.vendors).split(',') : [...VENDORS]).map((v) => assertName('vendor', v.trim())))];

  let target;
  if (found.diff !== undefined) {
    const inside = spawnSync('git', ['-C', io.cwd, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
    if (inside.stdout.trim() !== 'true') throw new UsageError('--diff needs a git repository');
    const ws = resolveWorkspace(io.cwd, io.env);
    try {
      const ref = found.diff === true ? null : found.diff;
      const ctx = collectReviewContext(ws.root, resolveReviewTarget(ws.root, ref ? { base: ref } : { scope: 'working-tree' }), { includeDiff: true });
      target = `${ctx.summary}\n\n${ctx.content}`;
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (/unknown revision|bad revision|ambiguous argument|not a valid/i.test(msg)) throw new UsageError(`unknown git ref: ${found.diff}`);
      throw new UsageError('diff too large or unreadable; pass file paths instead');
    }
  } else {
    const abs = positionals.map((p) => ensureAbsolutePath(io.cwd, p));
    const missing = abs.find((p) => !fs.existsSync(p));
    if (missing) throw new UsageError(`no such file: ${missing}`);
    target = abs.join('\n');
  }
  const prompt = buildCritiquePrompt(target);
  if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new UsageError('diff too large; pass file paths instead');

  const ready = vendors.filter((v) => !vendorMissing(v, io.env));
  if (!ready.length) {
    io.stderr.write(`crewmate: no vendor is ready: ${vendors.map((v) => vendorMissing(v, io.env)).join('; ')}\n`);
    return 7;
  }
  const ws = resolveWorkspace(io.cwd, io.env);
  const timeoutMs = options.timeout ? (await import('../names.mjs')).parseDuration(options.timeout) : 600_000;
  const ids = [];
  for (const vendor of ready) {
    const res = launchJob(ws, { vendor, kind: 'critique', prompt, cwd: fs.realpathSync(io.cwd), flags: { write: false, yolo: false, model: null, effort: null, timeoutMs, resumeConversationId: null } }, io.env);
    if ('jobId' in res) ids.push(res.jobId);
  }
  io.stdout.write(options.json ? `${JSON.stringify({ jobIds: ids })}\n` : `${ids.join('\n')}\n`);
  return 0;
}
