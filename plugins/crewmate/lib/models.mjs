// What each vendor offers: models, their effort levels, and the user's configured default.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findOnPath } from './vendors/index.mjs';

/** Levels agy accepts for --effort (agy --help, 1.4.12); agy does not report them per model. */
export const AGY_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * @typedef {{id: string, name: string, defaultEffort: string|null, efforts: string[]}} ModelInfo
 * @typedef {{vendor: 'codex'|'gemini', installed: boolean, available: boolean, error: string|null,
 *            models: ModelInfo[], configured: {model: string|null, effort: string|null}|null}} VendorModels
 */

/** @param {string} cmd @param {string[]} args @param {number} ms @param {NodeJS.ProcessEnv} env */
function run(cmd, args, ms, env) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: ms, killSignal: 'SIGKILL', env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** The user's codex defaults from ~/.codex/config.toml (top-level keys only). @param {NodeJS.ProcessEnv} env */
function codexConfigured(env) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(env.HOME || '', '.codex', 'config.toml'), 'utf8');
  } catch {
    return null;
  }
  const top = text.split(/^\s*\[/m)[0]; // keys before the first [table]
  const get = (k) => new RegExp(`^\\s*${k}\\s*=\\s*"([^"]*)"`, 'm').exec(top)?.[1] ?? null;
  return { model: get('model'), effort: get('model_reasoning_effort') };
}

/** @param {NodeJS.ProcessEnv} env @returns {VendorModels} */
export function codexModels(env = process.env) {
  const base = { vendor: /** @type {const} */ ('codex'), installed: false, available: false, error: null, models: [], configured: null };
  if (!findOnPath('codex', env)) return { ...base, error: 'not installed' };
  const configured = codexConfigured(env);
  // `codex debug models` is a debug command: parse defensively, fall back to the bundled catalog.
  for (const args of [['debug', 'models'], ['debug', 'models', '--bundled']]) {
    const r = run('codex', args, 20_000, env);
    if (!r.ok) continue;
    try {
      const list = JSON.parse(r.stdout).models;
      if (!Array.isArray(list)) continue;
      const models = list
        .filter((m) => m && typeof m.slug === 'string' && m.visibility !== 'hide')
        .map((m) => ({
          id: m.slug,
          name: String(m.display_name ?? m.slug),
          defaultEffort: m.default_reasoning_level ?? null,
          efforts: (m.supported_reasoning_levels ?? []).map((x) => x?.effort).filter(Boolean),
        }));
      if (models.length) return { ...base, installed: true, available: true, models, configured };
    } catch {}
  }
  return { ...base, installed: true, error: 'model list unavailable (codex debug models failed)', configured };
}

/** @param {NodeJS.ProcessEnv} env @returns {VendorModels} */
export function geminiModels(env = process.env) {
  const base = { vendor: /** @type {const} */ ('gemini'), installed: false, available: false, error: null, models: [], configured: null };
  if (!findOnPath('agy', env)) return { ...base, error: 'not installed' };
  const r = run('agy', ['models'], 30_000, env);
  // agy prints `id<TAB>name` lines (plus a "Fetching available models..." line); read both streams.
  const models = `${r.stdout}\n${r.stderr}`
    .split('\n')
    .map((l) => l.trim().split('\t'))
    .filter((p) => p.length >= 2 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p[0]))
    .map(([id, name]) => ({ id, name, defaultEffort: null, efforts: AGY_EFFORTS }));
  if (!r.ok || !models.length) return { ...base, installed: true, error: 'model list unavailable (run `agy` once to sign in)' };
  return { ...base, installed: true, available: true, models };
}

/** @param {'codex'|'gemini'} vendor @param {NodeJS.ProcessEnv} [env] */
export function vendorModels(vendor, env = process.env) {
  return vendor === 'codex' ? codexModels(env) : geminiModels(env);
}

/**
 * Check --model/--effort against what the vendor offers. Returns an error message, or null when
 * the values are fine or cannot be checked (an unreadable catalog never blocks a job).
 * @param {'codex'|'gemini'} vendor @param {string|null} model @param {string|null} effort @param {NodeJS.ProcessEnv} env
 */
export function checkModelChoice(vendor, model, effort, env) {
  if (!model && !effort) return null;
  const info = vendorModels(vendor, env);
  if (!info.available) {
    if (vendor === 'gemini' && effort && !AGY_EFFORTS.includes(effort)) return `unknown gemini effort "${effort}"; choose one of: ${AGY_EFFORTS.join(', ')}`;
    return null;
  }
  let chosen = null;
  if (model) {
    chosen = info.models.find((m) => m.id === model);
    if (!chosen) return `unknown ${vendor} model "${model}"; choose one of: ${info.models.map((m) => m.id).join(', ')}`;
  } else if (info.configured?.model) {
    chosen = info.models.find((m) => m.id === info.configured.model) ?? null;
  }
  const efforts = chosen?.efforts?.length ? chosen.efforts : vendor === 'gemini' ? AGY_EFFORTS : null;
  if (effort && efforts && !efforts.includes(effort)) {
    return `${vendor} model "${chosen?.id ?? 'default'}" does not support effort "${effort}"; choose one of: ${efforts.join(', ')}`;
  }
  return null;
}
