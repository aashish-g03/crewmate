// `crewmate setup [--json]`: Node and vendor readiness, with exact fix commands.
import { spawnSync } from 'node:child_process';
import { parseArgs } from '../vendored/args.mjs';
import { findOnPath, INSTALL_TEXT } from '../vendors/index.mjs';

/** spawnSync with a hard timeout; a signal or timeout counts as failure. */
function probe(cmd, args, timeoutMs, env) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, env, stdio: ['ignore', 'pipe', 'pipe'], killSignal: 'SIGKILL' });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** @param {NodeJS.ProcessEnv} env */
function checkCodex(env) {
  if (!findOnPath('codex', env)) return { ready: false, version: null, fix: INSTALL_TEXT.codex };
  const v = probe('codex', ['--version'], 5000, env);
  const version = v.ok ? v.stdout.trim().split('\n')[0] : null;
  const login = probe('codex', ['login', 'status'], 10_000, env);
  return login.ok ? { ready: true, version, fix: null } : { ready: false, version, fix: 'run `codex login`' };
}

/** @param {NodeJS.ProcessEnv} env */
function checkGemini(env) {
  if (!findOnPath('agy', env)) return { ready: false, version: null, fix: INSTALL_TEXT.gemini };
  const v = probe('agy', ['--version'], 5000, env);
  const version = v.ok ? v.stdout.trim().split('\n')[0] : null;
  const limit = Number(env.CREWMATE_PROBE_MS ?? 30_000);
  const p = probe('agy', ['-p', 'Reply with the word ok', '--output-format', 'stream-json', '--mode', 'plan', '--print-timeout', '30s'], limit, env);
  const success = p.stdout.split('\n').some((l) => {
    try {
      const o = JSON.parse(l);
      return o.event === 'result' && o.result?.status === 'SUCCESS';
    } catch {
      return false;
    }
  });
  return success ? { ready: true, version, fix: null } : { ready: false, version, fix: 'run `agy` once to sign in' };
}

/** @param {string[]} argv @param {any} io */
export async function run(argv, io) {
  const { options } = parseArgs(argv, { booleanOptions: ['json'] });
  const major = Number(process.versions.node.split('.')[0]);
  const node = { ok: major >= 20, version: process.versions.node };
  const vendors = { codex: checkCodex(io.env), gemini: checkGemini(io.env) };
  const anyReady = Object.values(vendors).some((v) => v.ready);
  if (options.json) {
    io.stdout.write(`${JSON.stringify({ node, vendors })}\n`);
  } else {
    io.stdout.write(`node: ${node.ok ? 'ready' : 'not ready: install Node 20 or later'} (${node.version})\n`);
    for (const [name, v] of Object.entries(vendors)) {
      const ver = v.version ? ` (${v.version})` : '';
      io.stdout.write(`${name}: ${v.ready ? 'ready' : `not ready: ${v.fix}`}${ver}\n`);
    }
  }
  return anyReady && node.ok ? 0 : 3;
}
