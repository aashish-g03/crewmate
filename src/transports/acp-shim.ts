#!/usr/bin/env bun
/**
 * ACP protocol shim — wraps ANY CLI as an ACP-compatible agent.
 *
 * Runs as a persistent process speaking JSON-RPC 2.0 on stdin/stdout.
 * Translates ACP protocol calls (initialize, session/new, session/prompt,
 * session/close, session/setMode, session/setModel) into CLI invocations.
 *
 * Usage:
 *   bun src/transports/acp-shim.ts <binary> [args...]
 *
 * Example:
 *   bun src/transports/acp-shim.ts codex exec --skip-git-repo-check
 *   bun src/transports/acp-shim.ts kimi -p --quiet --plan
 *   bun src/transports/acp-shim.ts claude -p --output-format=json
 *
 * The shim:
 * - Keeps a session map in memory (sessions are just prompt history)
 * - On session/prompt: concatenates prior turns + new prompt, spawns
 *   the CLI binary, captures stdout, returns as agent_message_chunk
 * - Supports {prompt} placeholder substitution in args
 * - Streams tool_call notifications for visibility
 *
 * This is how Zed handles non-ACP CLIs — a wrapper that speaks the
 * protocol while the underlying CLI stays prompt-in/text-out.
 */

import * as readline from 'node:readline';

interface Session {
  id: string;
  cwd?: string;
  turns: Array<{ prompt: string; response: string }>;
  mode: string;
  model: string;
}

const sessions = new Map<string, Session>();
const activeProcs = new Map<string, ReturnType<typeof Bun.spawn>>();
let nextSessionNum = 1;
let initialized = false;

const shimBinaryRaw = process.argv[2];
if (!shimBinaryRaw) {
  process.stderr.write('Usage: acp-shim <binary> [args...]\n');
  process.exit(2);
}
const shimBinary: string = shimBinaryRaw;
const shimArgs: string[] = process.argv.slice(3);

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line: string) => {
  line = line.trim();
  if (!line) return;

  let msg: { jsonrpc: string; id?: number | string; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method && msg.id !== undefined) {
    void handleRequest(msg.id, msg.method, msg.params ?? {});
  } else if (msg.method && msg.id === undefined) {
    handleNotification(msg.method, msg.params ?? {});
  }
});

function respond(id: number | string, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id: number | string, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function sendNotification(method: string, params: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

async function handleRequest(id: number | string, method: string, params: Record<string, unknown>): Promise<void> {
  switch (method) {
    case 'initialize': {
      respond(id, {
        protocolVersion: 1,
        agentInfo: {
          name: `${shimBinary}-shim`,
          title: `${shimBinary} (via crewmate ACP shim)`,
          version: '0.1.0',
        },
        agentCapabilities: {
          sessionCapabilities: { close: true },
          promptCapabilities: {},
        },
      });
      break;
    }

    case 'session/new': {
      if (!initialized) { respondError(id, -32600, 'Not initialized'); return; }
      const sessionId = `shim_${shimBinary}_${nextSessionNum++}`;
      const cwd = typeof params.cwd === 'string' ? params.cwd : undefined;
      sessions.set(sessionId, {
        id: sessionId,
        cwd,
        turns: [],
        mode: 'default',
        model: shimBinary,
      });
      respond(id, {
        sessionId,
        modes: {
          availableModes: [{ id: 'default', name: 'Default' }],
          currentModeId: 'default',
        },
        models: {
          availableModels: [{ modelId: shimBinary, name: shimBinary }],
          currentModelId: shimBinary,
        },
      });
      break;
    }

    case 'session/prompt': {
      if (!initialized) { respondError(id, -32600, 'Not initialized'); return; }
      const sessionId = params.sessionId as string;
      const session = sessions.get(sessionId);
      if (!session) { respondError(id, -32602, `Unknown session: ${sessionId}`); return; }

      const promptBlocks = params.prompt as Array<{ type?: string; text?: string }> | undefined;
      const promptText = promptBlocks?.map(b => b.text ?? '').join('') ?? '';

      // Build the full prompt with context from prior turns
      let fullPrompt = promptText;
      if (session.turns.length > 0) {
        const history = session.turns
          .map((t, i) => `Turn ${i + 1}:\nUser: ${t.prompt}\nAssistant: ${t.response}`)
          .join('\n\n');
        fullPrompt = `This is turn ${session.turns.length + 1} of a continuing conversation. Prior turns:\n\n${history}\n\nCurrent turn:\nUser: ${promptText}`;
      }

      const toolCallId = `cli-${session.turns.length + 1}-${Date.now()}`;

      // Notify: tool_call for the CLI invocation
      sendNotification('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId,
          status: 'in_progress',
          title: `${shimBinary} ${shimArgs.filter(a => a !== '{prompt}').join(' ')}`.trim(),
          kind: 'command',
        },
      });

      try {
        const startMs = Date.now();

        // Build argv: substitute {prompt} in args
        const argv = [shimBinary, ...shimArgs.map(a =>
          a === '{prompt}' ? fullPrompt : a.replaceAll('{prompt}', fullPrompt)
        )];

        const proc = Bun.spawn(argv, {
          cwd: session.cwd,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env },
        });

        // Track active process for cancellation
        activeProcs.set(sessionId, proc);

        const [stdout, stderr, exitCode] = await Promise.all([
          drainStream(proc.stdout),
          drainStream(proc.stderr),
          proc.exited,
        ]);

        activeProcs.delete(sessionId);
        const durationMs = Date.now() - startMs;

        // Notify: tool_call done (same toolCallId)
        sendNotification('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'completed',
            title: shimBinary,
            kind: 'command',
          },
        });

        if (exitCode !== 0) {
          const errorMsg = stderr.trim() || `Process exited with code ${exitCode}`;
          sendNotification('session/update', {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Error: ${errorMsg}` },
            },
          });
          respond(id, {
            stopReason: 'error',
            _meta: { quota: { token_count: { input_tokens: fullPrompt.length, output_tokens: 0 } } },
          });
          return;
        }

        const result = stdout.trim();

        // Store turn for session continuity
        session.turns.push({ prompt: promptText, response: result });

        // Stream response as chunk notification
        sendNotification('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: result },
          },
        });

        respond(id, {
          stopReason: 'end_turn',
          _meta: {
            quota: {
              token_count: {
                input_tokens: Math.round(fullPrompt.length / 4),
                output_tokens: Math.round(result.length / 4),
              },
            },
            durationMs,
          },
        });
      } catch (err) {
        respondError(id, -32603, `CLI execution failed: ${(err as Error).message}`);
      }
      break;
    }

    case 'session/close': {
      const sessionId = params.sessionId as string;
      sessions.delete(sessionId);
      respond(id, { success: true });
      break;
    }

    case 'session/setMode': {
      const sessionId = params.sessionId as string;
      const session = sessions.get(sessionId);
      if (session) session.mode = params.modeId as string;
      respond(id, { modeId: params.modeId });
      break;
    }

    case 'session/setModel': {
      const sessionId = params.sessionId as string;
      const session = sessions.get(sessionId);
      if (session) session.model = params.modelId as string;
      respond(id, { modelId: params.modelId });
      break;
    }

    default:
      respondError(id, -32601, `Method not found: ${method}`);
  }
}

function handleNotification(method: string, params: Record<string, unknown>): void {
  if (method === 'notifications/initialized') {
    initialized = true;
    process.stderr.write(`[acp-shim] initialized for ${shimBinary}\n`);
  } else if (method === 'notifications/cancel') {
    const sessionId = params.sessionId as string | undefined;
    process.stderr.write(`[acp-shim] cancel received for session=${sessionId}\n`);
    if (sessionId) {
      const proc = activeProcs.get(sessionId);
      if (proc) {
        try { proc.kill('SIGTERM'); } catch { /* already exited */ }
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* already exited */ }
        }, 2000).unref();
        activeProcs.delete(sessionId);
      }
    }
  }
}

async function drainStream(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) chunks.push(tail);
  } catch {
    // stream closed
  }
  return chunks.join('');
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
