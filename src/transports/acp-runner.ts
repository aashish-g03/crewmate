// src/transports/acp-runner.ts
import type { Subprocess } from 'bun';
import type { AgentCard } from '../envelope.ts';
import type { RunnerResult } from '../types.ts';
import { JsonRpcClient } from './jsonrpc.ts';
import { log } from '../logger.ts';

const SIGKILL_GRACE_MS = 5000;
const INITIALIZE_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 300_000;

interface AcpSession {
  sessionId: string;
  turnCount: number;
}

export class AcpRunner {
  private proc: Subprocess<'pipe', 'pipe', 'pipe'> | null = null;
  private rpc: JsonRpcClient | null = null;
  private sessions = new Map<string, AcpSession>();
  private initialized = false;
  private stderrChunks: string[] = [];
  private card: AgentCard;
  private cwd: string | undefined;

  constructor(card: AgentCard, opts?: { cwd?: string }) {
    this.card = card;
    this.cwd = opts?.cwd;
  }

  async ensureRunning(): Promise<void> {
    if (this.proc && this.initialized) return;
    await this.spawn();
  }

  private async spawn(): Promise<void> {
    const argv = this.card.acpCommand;
    if (!argv || argv.length === 0) {
      throw new Error(`Agent ${this.card.name} has no acpCommand`);
    }

    this.proc = Bun.spawn(argv, {
      cwd: this.cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    });

    const stdin = this.proc.stdin;
    this.rpc = new JsonRpcClient({
      write: (data: string) => {
        stdin.write(data);
        stdin.flush();
      },
      defaultTimeoutMs: REQUEST_TIMEOUT_MS,
    });

    this.drainStdout();
    this.drainStderr();

    const resp = await this.rpc.request(
      'initialize',
      {
        protocolVersion: '1',
        clientInfo: { name: 'crewmate', version: '0.2.0' },
        clientCapabilities: {},
      },
      INITIALIZE_TIMEOUT_MS,
    );

    if (resp.error) {
      throw new Error(
        `ACP initialize failed: ${resp.error.message} (code=${resp.error.code})`,
      );
    }

    this.rpc.notify('notifications/initialized');
    this.initialized = true;

    log({
      event: 'acp_initialized',
      agent: this.card.name,
      pid: this.proc.pid,
    });
  }

  private drainStdout(): void {
    if (!this.proc?.stdout) return;
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    const rpc = this.rpc!;
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          rpc.feed(decoder.decode(value, { stream: true }));
        }
        const tail = decoder.decode();
        if (tail) rpc.feed(tail);
      } catch {
        // stream closed
      }
      this.initialized = false;
    })();
  }

  private drainStderr(): void {
    if (!this.proc?.stderr) return;
    const reader = this.proc.stderr.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          this.stderrChunks.push(decoder.decode(value, { stream: true }));
          if (this.stderrChunks.length > 1000) {
            this.stderrChunks.splice(0, this.stderrChunks.length - 1000);
          }
        }
      } catch {
        // stream closed
      }
    })();
  }

  async createSession(opts?: { cwd?: string }): Promise<string> {
    await this.ensureRunning();
    const resp = await this.rpc!.request('sessions/create', {
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    });
    if (resp.error) {
      throw new Error(`sessions/create failed: ${resp.error.message}`);
    }
    const result = resp.result as { sessionId: string };
    const sessionId = result.sessionId;
    this.sessions.set(sessionId, { sessionId, turnCount: 0 });
    log({
      event: 'acp_session_created',
      agent: this.card.name,
      message: `session=${sessionId}`,
    });
    return sessionId;
  }

  async sendMessage(
    sessionId: string,
    prompt: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<RunnerResult> {
    await this.ensureRunning();
    const startedAt = Date.now();

    let aborted = false;
    const onAbort = () => {
      aborted = true;
    };
    opts?.signal?.addEventListener('abort', onAbort, { once: true });

    const stderrStart = this.stderrChunks.length;

    try {
      const resp = await this.rpc!.request(
        'sessions/message',
        { sessionId, message: { role: 'user', content: prompt } },
        opts?.timeoutMs ?? REQUEST_TIMEOUT_MS,
      );

      if (aborted) {
        return {
          exitCode: null,
          stdout: '',
          stderr: this.stderrChunks.slice(stderrStart).join(''),
          durationMs: Date.now() - startedAt,
          hint: 'aborted',
        };
      }

      if (resp.error) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: resp.error.message,
          durationMs: Date.now() - startedAt,
        };
      }

      const result = resp.result as {
        message?: { content?: string };
      };
      const content = result?.message?.content ?? '';

      const session = this.sessions.get(sessionId);
      if (session) session.turnCount++;

      return {
        exitCode: 0,
        stdout: content,
        stderr: this.stderrChunks.slice(stderrStart).join(''),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        exitCode: null,
        stdout: '',
        stderr: (err as Error).message,
        durationMs: Date.now() - startedAt,
        hint: aborted ? 'aborted' : 'timeout',
      };
    } finally {
      opts?.signal?.removeEventListener('abort', onAbort);
    }
  }

  getSession(sessionId: string): AcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  async shutdown(): Promise<void> {
    if (!this.proc) return;
    this.rpc?.cancelAll('shutdown');

    try {
      this.proc.kill('SIGTERM');
    } catch {
      /* already exited */
    }

    const killTimer = setTimeout(() => {
      try {
        this.proc?.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    }, SIGKILL_GRACE_MS);

    await this.proc.exited;
    clearTimeout(killTimer);

    log({
      event: 'acp_shutdown',
      agent: this.card.name,
      pid: this.proc.pid,
    });

    this.proc = null;
    this.rpc = null;
    this.initialized = false;
    this.sessions.clear();
  }

  get alive(): boolean {
    return this.proc !== null && this.initialized;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }
}
