import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Copies the bundled `templates/crewmate.md` into Claude Code's agents
 * directory. Keeps the npm package responsible for *its own* installation —
 * the user never has to know where Claude Code looks for subagents.
 *
 *   --global   ~/.claude/agents/crewmate.md      (default; available everywhere)
 *   --project  ./.claude/agents/crewmate.md      (cwd-scoped only)
 *   --uninstall  removes the file from whichever scope is selected
 *
 * Idempotent. Re-running overwrites, so registry / template changes propagate.
 * Also cleans up the legacy `mesh-router.md` name on install.
 */

interface Opts {
  scope: 'global' | 'project';
  uninstall: boolean;
  force: boolean;
}

function templatePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'templates', 'crewmate.md');
}

function targetPath(scope: 'global' | 'project'): string {
  const dir =
    scope === 'global'
      ? path.join(os.homedir(), '.claude', 'agents')
      : path.join(process.cwd(), '.claude', 'agents');
  return path.join(dir, 'crewmate.md');
}

function legacyTargetPath(scope: 'global' | 'project'): string {
  const dir =
    scope === 'global'
      ? path.join(os.homedir(), '.claude', 'agents')
      : path.join(process.cwd(), '.claude', 'agents');
  return path.join(dir, 'mesh-router.md');
}

async function quietUnlink(p: string): Promise<boolean> {
  try {
    await fs.unlink(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export async function cmdInstallClaudeAgent(opts: Opts): Promise<void> {
  const target = targetPath(opts.scope);
  const legacy = legacyTargetPath(opts.scope);

  if (opts.uninstall) {
    const removedNew = await quietUnlink(target);
    const removedOld = await quietUnlink(legacy);
    if (removedNew) process.stderr.write(`[crewmate] removed ${target}\n`);
    if (removedOld) process.stderr.write(`[crewmate] removed legacy ${legacy}\n`);
    if (!removedNew && !removedOld) {
      process.stderr.write(`[crewmate] nothing to remove\n`);
    }
    return;
  }

  const tpl = templatePath();
  let content: string;
  try {
    content = await fs.readFile(tpl, 'utf8');
  } catch (err) {
    process.stderr.write(
      `[crewmate] template not found at ${tpl}. ` +
        `If you cloned the repo, this is a packaging bug; please report.\n`
    );
    throw err;
  }

  await fs.mkdir(path.dirname(target), { recursive: true });

  if (!opts.force) {
    try {
      await fs.access(target);
      process.stderr.write(
        `[crewmate] ${target} already exists. Re-run with --force to overwrite.\n`
      );
      return;
    } catch {
      // not present, proceed
    }
  }

  await fs.writeFile(target, content, 'utf8');

  // Clean up legacy mesh-router.md if it exists
  if (await quietUnlink(legacy)) {
    process.stderr.write(`[crewmate] removed legacy mesh-router.md\n`);
  }

  process.stderr.write(`[crewmate] installed crewmate agent at ${target}\n`);
  process.stderr.write(
    `[crewmate] tip: start a worker pool with \`crewmate up gemini-worker\`, ` +
      `then just ask Claude Code to "audit src/ with crewmate" or "get a second opinion".\n`
  );
}
