import { writeCancelSentinel } from '../transports/mailbox.ts';
import { log } from '../logger.ts';

export async function cmdCancel(
  agent: string | undefined,
  taskId: string | undefined
): Promise<void> {
  if (!agent || !taskId) {
    process.stderr.write('Usage: crewmate cancel <agent> <taskId>\n');
    process.exit(2);
  }
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(agent)) {
    process.stderr.write(
      `[crewmate] invalid agent name: "${agent}" — must be lowercase alphanumeric with hyphens\n`
    );
    process.exit(2);
  }
  const dest = await writeCancelSentinel(agent, taskId);
  log({ event: 'task_canceled', agent, taskId, reason: 'cli cancel sentinel' });
  process.stderr.write(`[crewmate] cancel sentinel written: ${dest}\n`);
}
