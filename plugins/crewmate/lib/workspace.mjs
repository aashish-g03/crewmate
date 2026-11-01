// Workspace root and state folder: ~/.crewmate/workspaces/<slug>-<hash16>/.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * @typedef {{root: string, slug: string, stateDir: string}} Workspace
 */

/**
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Workspace}
 */
export function resolveWorkspace(cwd, env = process.env) {
  const git = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const top = git.status === 0 ? git.stdout.trim() : '';
  const root = fs.realpathSync(top || cwd);
  const slug = path.basename(root).replace(/[^A-Za-z0-9._-]/g, '-') || 'workspace';
  const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
  const home = env.CREWMATE_HOME || os.homedir();
  return { root, slug, stateDir: path.join(home, '.crewmate', 'workspaces', `${slug}-${hash}`) };
}
