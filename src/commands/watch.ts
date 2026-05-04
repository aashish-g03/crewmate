import fs from 'node:fs/promises';
import path from 'node:path';
import chokidar from 'chokidar';
import { homeDir } from '../paths.ts';

/**
 * `crewmate watch [agent|taskId]` — tail per-task log files across the mesh.
 *
 *   crewmate watch                  # everything
 *   crewmate watch gemini-worker    # one agent
 *   crewmate watch <uuid>           # one task across any agent
 *
 * Implementation: chokidar watches `~/.crewmate/<agent>/logs/<taskId>.{stdout,stderr}.log`.
 * For each `add` and `change` event we read only the newly-appended bytes
 * (tracked via a per-file offset map) and stream them to our stdout with a
 * `[<agent>/<taskId>:<stream>]` prefix. No external `tail` binary required.
 */

const LOG_RE = /\/([^/]+)\/logs\/([0-9a-fA-F-]+)\.(stdout|stderr|progress)\.log$/;

function uuidish(s: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    s
  );
}

export async function cmdWatch(filter?: string): Promise<void> {
  const root = homeDir();

  // Make sure the root exists so chokidar doesn't crash on a fresh machine.
  try {
    await fs.access(root);
  } catch {
    process.stderr.write(
      `[crewmate] ${root} does not exist. Run \`crewmate init\` first.\n`
    );
    process.exit(2);
  }

  const filterAgent = filter && !uuidish(filter) ? filter : undefined;
  const filterTask = filter && uuidish(filter) ? filter : undefined;

  const offsets = new Map<string, number>();

  const matches = (filePath: string): { agent: string; taskId: string; stream: string } | null => {
    const m = filePath.match(LOG_RE);
    if (!m) return null;
    const [, agent, taskId, stream] = m;
    if (filterAgent && agent !== filterAgent) return null;
    if (filterTask && taskId !== filterTask) return null;
    return { agent: agent!, taskId: taskId!, stream: stream! };
  };

  const drain = async (filePath: string): Promise<void> => {
    const tag = matches(filePath);
    if (!tag) return;
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return; // file vanished between event and read
    }
    const prev = offsets.get(filePath) ?? 0;
    if (stat.size <= prev) return;

    const fd = await fs.open(filePath, 'r');
    try {
      const len = stat.size - prev;
      const buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, prev);
      offsets.set(filePath, stat.size);
      const text = buf.toString('utf8');
      const prefix = `[${tag.agent}/${tag.taskId.slice(0, 8)}:${tag.stream}] `;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i]!;
        // Don't tack a trailing prefix onto an empty final line from a hanging \n.
        if (i === lines.length - 1 && ln.length === 0) continue;
        process.stdout.write(prefix + ln + '\n');
      }
    } finally {
      await fd.close();
    }
  };

  const watcher = chokidar.watch(path.join(root, '*', 'logs', '*.log'), {
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 25, pollInterval: 25 },
    ignoreInitial: false,
  });

  watcher.on('add', (p) => void drain(p));
  watcher.on('change', (p) => void drain(p));
  watcher.on('error', (err) => {
    process.stderr.write(`[crewmate] watcher error: ${(err as Error).message}\n`);
  });

  process.stderr.write(
    `[crewmate] watching ${
      filter ? (filterAgent ? `agent=${filterAgent}` : `task=${filterTask}`) : 'all agents'
    } — Ctrl-C to stop\n`
  );

  // Block forever; chokidar keeps the event loop alive.
  await new Promise<void>(() => {});
}
