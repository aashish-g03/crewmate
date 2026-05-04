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

export interface AcpProgressEvent {
  type: 'thinking' | 'tool_start' | 'tool_done' | 'chunk' | 'info';
  tool?: string;
  title?: string;
  kind?: string;
  path?: string;
  text?: string;
}

export type AcpProgressHandler = (event: AcpProgressEvent) => void;

export class AcpRunner {
  private proc: Subprocess<'pipe', 'pipe', 'pipe'> | null = null;
  private rpc: JsonRpcClient | null = null;
  private sessions = new Map<string, AcpSession>();
  private initialized = false;
  private stderrChunks: string[] = [];
  private card: AgentCard;
  private cwd: string | undefined;
  private streamedContent: string[] = [];
  private spawning: Promise<void> | null = null;
  private progressHandler: AcpProgressHandler | null = null;

  constructor(card: AgentCard, opts?: { cwd?: string }) {
    this.card = card;
    this.cwd = opts?.cwd;
  }

  onProgress(handler: AcpProgressHandler): void {
    this.progressHandler = handler;
  }

  async ensureRunning(): Promise<void> {
    if (this.proc && this.initialized) return;
    if (this.spawning) return this.spawning;
    this.spawning = this.spawn().finally(() => { this.spawning = null; });
    return this.spawning;
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

    this.rpc.onNotification((_method, params) => {
      const update = params.update as Record<string, unknown> | undefined;
      if (!update) return;
      const updateType = update.sessionUpdate as string | undefined;

      if (updateType === 'agent_message_chunk') {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === 'text' && content.text) {
          this.streamedContent.push(content.text);
          this.progressHandler?.({ type: 'chunk', text: content.text });
        }
      } else if (updateType === 'tool_call') {
        const title = update.title as string | undefined;
        const kind = update.kind as string | undefined;
        const locations = update.locations as Array<{ path?: string }> | undefined;
        const path = locations?.[0]?.path;
        this.progressHandler?.({ type: 'tool_start', title, kind, path });
      } else if (updateType === 'tool_call_update') {
        const title = update.title as string | undefined;
        const kind = update.kind as string | undefined;
        const status = update.status as string | undefined;
        if (status === 'completed') {
          this.progressHandler?.({ type: 'tool_done', title, kind });
        }
      }
    });

    this.rpc.onRequest(async (method, params) => {
      if (method === 'textDocument/read' || method === 'resources/readTextFile' || method === 'readTextFile') {
        const filePath = params.path as string | undefined;
        if (!filePath) {
          return { error: { code: -32602, message: 'Missing path parameter' } };
        }
        try {
          const fs = await import('node:fs/promises');
          const content = await fs.readFile(filePath, 'utf8');
          return { result: { content } };
        } catch (err) {
          return { error: { code: -32603, message: `File read failed: ${(err as Error).message}` } };
        }
      }

      if (method === 'textDocument/write' || method === 'resources/writeTextFile' || method === 'writeTextFile') {
        return { error: { code: -32601, message: 'Write operations not permitted (read-only worker)' } };
      }

      return { error: { code: -32601, message: `Method not found: ${method}` } };
    });

    this.drainStdout();
    this.drainStderr();

    const resp = await this.rpc.request(
      'initialize',
      {
        protocolVersion: 1,
        clientInfo: { name: 'crewmate', version: '0.2.0' },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
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

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.ensureRunning();
    const resp = await this.rpc!.request('session/setMode', { sessionId, modeId }, 10_000);
    if (resp.error) {
      log({
        event: 'acp_set_mode_failed',
        agent: this.card.name,
        error: resp.error.message,
      });
    }
  }

  async createSession(opts?: { cwd?: string }): Promise<string> {
    await this.ensureRunning();
    const resp = await this.rpc!.request('session/new', {
      cwd: opts?.cwd ?? process.cwd(),
      mcpServers: [],
    });
    if (resp.error) {
      throw new Error(`session/new failed: ${resp.error.message}`);
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
      this.rpc?.notify('notifications/cancel', { sessionId });
    };
    opts?.signal?.addEventListener('abort', onAbort, { once: true });

    const stderrStart = this.stderrChunks.length;
    this.streamedContent = [];

    try {
      const resp = await this.rpc!.request(
        'session/prompt',
        {
          sessionId,
          prompt: [{ type: 'text', text: prompt }],
        },
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

      const content = this.streamedContent.join('');

      const meta = (resp.result as Record<string, unknown>)?._meta as Record<string, unknown> | undefined;
      const quota = meta?.quota as Record<string, unknown> | undefined;
      const tokenCount = quota?.token_count as { input_tokens?: number; output_tokens?: number } | undefined;

      const session = this.sessions.get(sessionId);
      if (session) session.turnCount++;

      return {
        exitCode: 0,
        stdout: content,
        stderr: this.stderrChunks.slice(stderrStart).join(''),
        durationMs: Date.now() - startedAt,
        inputTokens: tokenCount?.input_tokens,
        outputTokens: tokenCount?.output_tokens,
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

  async closeSession(sessionId: string): Promise<void> {
    if (!this.rpc || !this.initialized) return;
    try {
      await this.rpc.request('session/close', { sessionId }, 5_000);
    } catch {
      // best effort — agent may have already closed it
    }
    this.sessions.delete(sessionId);
  }

  getSession(sessionId: string): AcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  async shutdown(): Promise<void> {
    if (!this.proc) return;
    this.rpc?.cancelAll('shutdown');

    // Close all sessions before killing the process
    for (const sid of this.sessions.keys()) {
      try {
        this.rpc?.notify('session/close', { sessionId: sid });
      } catch { /* shutting down */ }
    }
    this.sessions.clear();

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
  }

  get alive(): boolean {
    return this.proc !== null && this.initialized;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }
}
