// Test helpers: temp homes, a PATH that holds only the chosen fake CLIs, and a real-CLI runner.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = path.join(ROOT, 'plugins/crewmate/bin/crewmate');
export const FIXTURES = path.join(ROOT, 'tests/fixtures');
const FAKE_BIN = path.join(ROOT, 'tests/fake-bin');

export function tempDir(prefix = 'crewmate-test-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function tempHome() {
  const home = tempDir('crewmate-home-');
  return { home, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

/** A PATH holding `node` plus the chosen fakes (only those that exist), then /usr/bin:/bin. */
export function fakePath(fakes = ['codex', 'agy']) {
  const dir = tempDir('crewmate-path-');
  fs.symlinkSync(process.execPath, path.join(dir, 'node'));
  for (const name of fakes) {
    const src = path.join(FAKE_BIN, name);
    if (fs.existsSync(src)) fs.symlinkSync(src, path.join(dir, name));
  }
  return `${dir}:/usr/bin:/bin`;
}

/** Run the real CLI. Resolves {code, stdout, stderr}. */
export function runCli(args, { cwd = ROOT, env = {}, input, fakes = ['codex', 'agy'], home } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: { PATH: fakePath(fakes), HOME: home ?? os.homedir(), ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function waitFor(fn, ms = 5000, step = 25) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`waitFor timed out after ${ms}ms`);
    await new Promise((r) => setTimeout(r, step));
  }
}
