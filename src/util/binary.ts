import type { AgentCard } from '../envelope.ts';

/** The first token of cliCommand is the executable we need on PATH. */
export function binaryName(card: AgentCard): string {
  const first = card.cliCommand[0];
  if (!first) throw new Error(`agent ${card.name} has empty cliCommand`);
  return first;
}

/** True if a binary is callable from PATH. Cheap, cached for the process lifetime. */
const cache = new Map<string, boolean>();
export async function isBinaryAvailable(name: string): Promise<boolean> {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const proc = Bun.spawn(['/usr/bin/env', 'which', name], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const ok = (await proc.exited) === 0;
  cache.set(name, ok);
  return ok;
}
