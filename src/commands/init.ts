import { ensureHome, ensureAgentTree, agentCardFile, agentConfigFile } from '../paths.ts';
import { writeJsonAtomic } from '../transports/mailbox.ts';
import { BUILT_IN_AGENTS, DEFAULT_AGENT_CONFIG } from '../agents/registry.ts';
import { log } from '../logger.ts';

/**
 * Idempotent initializer:
 *   - mkdir ~/.crewmate
 *   - for each built-in agent, mkdir its tree and write agent-card.json + config.json
 *
 * Re-running overwrites cards (so registry edits propagate) but preserves
 * any custom config.json the user has tweaked.
 */
export async function cmdInit(): Promise<void> {
  await ensureHome();
  for (const [name, card] of Object.entries(BUILT_IN_AGENTS)) {
    await ensureAgentTree(name);
    await writeJsonAtomic(agentCardFile(name), card);
    // Only seed config if missing — preserve user edits.
    try {
      await Bun.file(agentConfigFile(name)).text();
    } catch {
      await writeJsonAtomic(agentConfigFile(name), DEFAULT_AGENT_CONFIG);
    }
    process.stderr.write(`[crewmate] initialized agent: ${name}\n`);
  }
  log({ event: 'pool_started', message: 'init complete' });
}
