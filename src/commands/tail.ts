import fs from 'node:fs';
import fsp from 'node:fs/promises';
import chokidar from 'chokidar';
import { logFile, ensureHome } from '../paths.ts';

/**
 * `tail -f` ~/.crewmate/log.jsonl. If an agent filter is passed,
 * we drop lines whose `agent` field doesn't match.
 *
 * Implementation:
 *   - Print the current contents (best-effort).
 *   - Then watch the file with chokidar and on every change, read the slice
 *     after our last known offset.
 */
export async function cmdTail(agent: string | undefined): Promise<void> {
  await ensureHome();
  const file = logFile();

  // Ensure file exists so the watcher attaches
  try {
    await fsp.access(file);
  } catch {
    await fsp.writeFile(file, '');
  }

  let offset = 0;
  const stat = await fsp.stat(file);
  // Print existing content first
  if (stat.size > 0) {
    const buf = await fsp.readFile(file, 'utf8');
    emitLines(buf, agent);
    offset = stat.size;
  }

  const watcher = chokidar.watch(file, {
    ignoreInitial: true,
    awaitWriteFinish: false,
  });

  watcher.on('change', async () => {
    try {
      const cur = await fsp.stat(file);
      if (cur.size < offset) {
        // Truncated; reset
        offset = 0;
      }
      if (cur.size === offset) return;
      const stream = fs.createReadStream(file, {
        start: offset,
        end: cur.size,
        encoding: 'utf8',
      });
      let chunk = '';
      for await (const piece of stream) chunk += piece;
      offset = cur.size;
      emitLines(chunk, agent);
    } catch {
      /* file race; try again on next event */
    }
  });

  process.on('SIGINT', () => {
    void watcher.close().then(() => process.exit(0));
  });
}

function emitLines(buf: string, agentFilter: string | undefined): void {
  const lines = buf.split('\n');
  for (const line of lines) {
    if (!line) continue;
    if (agentFilter) {
      try {
        const obj = JSON.parse(line) as { agent?: string };
        if (obj.agent !== agentFilter) continue;
      } catch {
        continue;
      }
    }
    process.stdout.write(line + '\n');
  }
}
