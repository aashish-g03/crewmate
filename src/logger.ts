import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { logFile, homeDir } from './paths.ts';
import type { LogEvent } from './types.ts';

/**
 * NDJSON logger that appends to ~/.crewmate/log.jsonl.
 *
 * Uses an internal queue + single-flight writer so concurrent log() calls
 * across the supervisor and workers don't interleave partial lines.
 *
 * The stream is created lazily on first write so importing this module
 * never touches the filesystem.
 */

let stream: fs.WriteStream | null = null;
const queue: string[] = [];
let flushing = false;

async function ensureStream(): Promise<fs.WriteStream> {
  if (stream) return stream;
  await fsp.mkdir(homeDir(), { recursive: true });
  stream = fs.createWriteStream(logFile(), { flags: 'a' });
  stream.on('error', (err) => {
    // Last-resort: surface to stderr; we don't want logger errors to crash workers
    process.stderr.write(`[crewmate logger] write error: ${err.message}\n`);
  });
  return stream;
}

async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const s = await ensureStream();
    while (queue.length > 0) {
      const line = queue.shift()!;
      // backpressure: if write returns false, wait for drain
      const ok = s.write(line);
      if (!ok) {
        await new Promise<void>((resolve) => s.once('drain', () => resolve()));
      }
    }
  } finally {
    flushing = false;
  }
}

export function log(event: Omit<LogEvent, 'ts'> & { ts?: string }): void {
  const line =
    JSON.stringify({
      ts: event.ts ?? new Date().toISOString(),
      ...event,
    }) + '\n';
  queue.push(line);
  // Fire-and-forget; we don't await so log() stays sync-friendly
  void flush();
}

/** Best-effort flush + close, used during graceful shutdown. */
export async function closeLogger(): Promise<void> {
  await flush();
  if (stream) {
    await new Promise<void>((resolve) => stream!.end(() => resolve()));
    stream = null;
  }
}

/** Convenience: where the log file lives (for `tail` command). */
export function logFilePath(): string {
  return path.resolve(logFile());
}
