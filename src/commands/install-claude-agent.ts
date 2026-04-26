import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Copies the bundled `templates/mesh-router.md` into Claude Code's agents
 * directory. Keeps the npm package responsible for *its own* installation —
 * the user never has to know where Claude Code looks for subagents.
 *
 *   --global   ~/.claude/agents/mesh-router.md      (default; available everywhere)
 *   --project  ./.claude/agents/mesh-router.md      (cwd-scoped only)
 *   --uninstall  removes the file from whichever scope is selected
 *
 * Idempotent. Re-running overwrites, so registry / template changes propagate.
 */

interface Opts {
  scope: 'global' | 'project';
  uninstall: boolean;
  force: boolean;
}

function templatePath(): string {
  // Resolve from src/commands/install-claude-agent.ts up to package root.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'templates', 'mesh-router.md');
}

function targetPath(scope: 'global' | 'project'): string {
  const dir =
    scope === 'global'
      ? path.join(os.homedir(), '.claude', 'agents')
      : path.join(process.cwd(), '.claude', 'agents');
  return path.join(dir, 'mesh-router.md');
}

export async function cmdInstallClaudeAgent(opts: Opts): Promise<void> {
  const target = targetPath(opts.scope);

  if (opts.uninstall) {
    try {
      await fs.unlink(target);
      process.stderr.write(`[crewmate] removed ${target}\n`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        process.stderr.write(`[crewmate] nothing to remove at ${target}\n`);
      } else {
        throw err;
      }
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
  process.stderr.write(`[crewmate] installed mesh-router subagent at ${target}\n`);
  process.stderr.write(
    `[crewmate] tip: start a worker pool with \`crewmate up <agent>\`, ` +
      `then ask Claude Code to delegate via the mesh-router subagent.\n`
  );
}
