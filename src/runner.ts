import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentCard } from './envelope.ts';
import type { RunnerOptions, RunnerResult } from './types.ts';

/**
 * Subprocess executor.
 *
 * Substitutes "{prompt}" tokens in card.cliCommand literally with the prompt
 * string (no shell interpolation, so quoting / injection is a non-issue).
 *
 * Honors:
 *  - opts.signal:    SIGTERM the child, then SIGKILL after a 2s grace.
 *  - opts.timeoutMs: same pathway, but tags result.hint = 'timeout'.
 */

const SIGKILL_GRACE_MS = 2000;

export async function runCli(
  card: AgentCard,
  prompt: string,
  opts: RunnerOptions
): Promise<RunnerResult> {
  const argv = card.cliCommand.map((part) =>
    part === '{prompt}' ? prompt : part.replaceAll('{prompt}', prompt)
  );
  if (argv.length === 0) {
    throw new Error(`Agent ${card.name} has empty cliCommand`);
  }

  // Pre-create log file paths if requested
  if (opts.stdoutLogPath) {
    await fs.mkdir(path.dirname(opts.stdoutLogPath), { recursive: true });
  }
  if (opts.stderrLogPath) {
    await fs.mkdir(path.dirname(opts.stderrLogPath), { recursive: true });
  }

  const startedAt = Date.now();

  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });

  let hint: RunnerResult['hint'];
  let killed = false;

  const killChild = (reason: 'aborted' | 'timeout') => {
    if (killed) return;
    killed = true;
    hint = reason;
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already exited */
    }
    setTimeout(() => {
      if (proc.exitCode === null) {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already exited */
        }
      }
    }, SIGKILL_GRACE_MS).unref();
  };

  // Wire abort signal
  const onAbort = () => killChild('aborted');
  if (opts.signal.aborted) {
    killChild('aborted');
  } else {
    opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  // Wire timeout
  const timeoutHandle = setTimeout(() => killChild('timeout'), opts.timeoutMs);
  timeoutHandle.unref();

  // Drain streams concurrently with exit
  const [stdout, stderr, exitCode] = await Promise.all([
    drainStream(proc.stdout, opts.stdoutLogPath),
    drainStream(proc.stderr, opts.stderrLogPath),
    proc.exited,
  ]);

  clearTimeout(timeoutHandle);
  opts.signal.removeEventListener('abort', onAbort);

  return {
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
    hint,
  };
}

async function drainStream(
  stream: ReadableStream<Uint8Array> | undefined,
  logPath: string | undefined
): Promise<string> {
  if (!stream) return '';
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const chunks: string[] = [];
  let fileHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
  if (logPath) {
    fileHandle = await fs.open(logPath, 'a');
  }
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      chunks.push(text);
      if (fileHandle) {
        await fileHandle.write(value);
      }
    }
    const tail = decoder.decode();
    if (tail) chunks.push(tail);
  } finally {
    if (fileHandle) await fileHandle.close();
  }
  return chunks.join('');
}
