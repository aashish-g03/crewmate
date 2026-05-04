#!/usr/bin/env bun
/**
 * Mock ACP server for testing crewmate's ACP transport layer.
 *
 * Speaks JSON-RPC 2.0 over stdin/stdout. Implements the ACP protocol
 * surface that crewmate uses: initialize, session/new, session/prompt,
 * session/close, session/setMode, plus notifications (cancel, initialized).
 *
 * Tracks sessions, modes, cancel events, and close events in-memory
 * so tests can assert on protocol correctness.
 */

import * as readline from 'node:readline';

interface MockSession {
  turnCount: number;
  cwd?: string;
  modeId: string;
  closed: boolean;
  cancelCount: number;
}

const sessions = new Map<string, MockSession>();
let nextSessionNum = 1;
let initialized = false;
let totalCancelNotifications = 0;
let totalCloseRequests = 0;

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line: string) => {
  line = line.trim();
  if (!line) return;

  let msg: { jsonrpc: string; id?: number; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method && msg.id !== undefined) {
    handleRequest(msg.id, msg.method, msg.params ?? {});
  } else if (msg.method && msg.id === undefined) {
    handleNotification(msg.method, msg.params ?? {});
  }
});

function respond(id: number, result: unknown): void {
  const resp = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(resp + '\n');
}

function respondError(id: number, code: number, message: string): void {
  const resp = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(resp + '\n');
}

function sendNotification(method: string, params: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function sendRequest(id: number, method: string, params: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
}

function handleRequest(id: number, method: string, params: Record<string, unknown>): void {
  switch (method) {
    case 'initialize': {
      respond(id, {
        protocolVersion: 1,
        agentInfo: { name: 'mock-acp-server', version: '0.1.0' },
        agentCapabilities: {
          sessionCapabilities: { close: true },
          promptCapabilities: {},
        },
      });
      break;
    }

    case 'session/new': {
      if (!initialized) { respondError(id, -32600, 'Not initialized'); return; }
      const sessionId = `mock_session_${nextSessionNum++}`;
      const cwd = typeof params.cwd === 'string' ? params.cwd : undefined;
      sessions.set(sessionId, { turnCount: 0, cwd, modeId: 'default', closed: false, cancelCount: 0 });
      respond(id, {
        sessionId,
        modes: {
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'autoEdit', name: 'Auto Edit' },
            { id: 'plan', name: 'Plan' },
            { id: 'yolo', name: 'YOLO' },
          ],
          currentModeId: 'default',
        },
      });
      break;
    }

    case 'session/prompt': {
      if (!initialized) { respondError(id, -32600, 'Not initialized'); return; }
      const sessionId = params.sessionId as string;
      const session = sessions.get(sessionId);
      if (!session) { respondError(id, -32602, `Unknown session: ${sessionId}`); return; }
      if (session.closed) { respondError(id, -32600, `Session closed: ${sessionId}`); return; }

      session.turnCount++;
      const promptBlocks = params.prompt as Array<{ type?: string; text?: string }> | undefined;
      const promptText = promptBlocks?.map(b => b.text ?? '').join('') ?? '';

      // Simulate tool_call notification for prompts containing "read file"
      if (promptText.toLowerCase().includes('read file') || promptText.toLowerCase().includes('read_file')) {
        sendNotification('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: `read_file-${Date.now()}`,
            status: 'in_progress',
            title: 'mock-file.ts',
            kind: 'read',
            locations: [{ path: '/mock/path/mock-file.ts' }],
          },
        });
        sendNotification('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: `read_file-${Date.now()}`,
            status: 'completed',
            title: 'mock-file.ts',
            kind: 'read',
          },
        });
      }

      // Simulate a server-to-client file read request for prompts containing "host_read"
      if (promptText.includes('host_read:')) {
        const filePath = promptText.split('host_read:')[1]?.trim().split(/\s/)[0] ?? '';
        sendRequest(9000 + session.turnCount, 'readTextFile', { path: filePath });
      }

      const responseContent = `[${sessionId}:turn${session.turnCount}:mode=${session.modeId}] ${promptText}`;

      // Stream content via notification
      sendNotification('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: responseContent },
        },
      });

      // Include token usage metadata in response (like real Gemini)
      respond(id, {
        stopReason: 'end_turn',
        _meta: {
          quota: {
            token_count: {
              input_tokens: 1000 + promptText.length,
              output_tokens: responseContent.length,
            },
          },
        },
      });
      break;
    }

    case 'session/close': {
      totalCloseRequests++;
      const sessionId = params.sessionId as string;
      const session = sessions.get(sessionId);
      if (session) {
        session.closed = true;
      }
      respond(id, { success: true });
      break;
    }

    case 'session/setMode': {
      const sessionId = params.sessionId as string;
      const modeId = params.modeId as string;
      const session = sessions.get(sessionId);
      if (!session) { respondError(id, -32602, `Unknown session: ${sessionId}`); return; }
      session.modeId = modeId;
      // Echo back the new mode
      sendNotification('session/update', {
        sessionId,
        update: { sessionUpdate: 'current_mode_update', currentModeId: modeId },
      });
      respond(id, { modeId });
      break;
    }

    case '_test/stats': {
      // Internal: test harness can query server state
      const sessionId = params.sessionId as string | undefined;
      if (sessionId) {
        const s = sessions.get(sessionId);
        respond(id, {
          session: s ? { ...s } : null,
          totalCancelNotifications,
          totalCloseRequests,
        });
      } else {
        respond(id, {
          sessionCount: sessions.size,
          totalCancelNotifications,
          totalCloseRequests,
          sessions: Object.fromEntries(
            [...sessions.entries()].map(([k, v]) => [k, { ...v }])
          ),
        });
      }
      break;
    }

    default:
      respondError(id, -32601, `Method not found: ${method}`);
  }
}

function handleNotification(method: string, params: Record<string, unknown>): void {
  if (method === 'notifications/initialized') {
    initialized = true;
    process.stderr.write('[mock-acp] initialized\n');
  } else if (method === 'notifications/cancel') {
    totalCancelNotifications++;
    const sessionId = params.sessionId as string | undefined;
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (session) session.cancelCount++;
    }
    process.stderr.write(`[mock-acp] cancel received for session=${sessionId}\n`);
  } else if (method === 'session/close') {
    // Some callers send close as notification (during shutdown)
    totalCloseRequests++;
    const sessionId = params.sessionId as string | undefined;
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (session) session.closed = true;
    }
  }
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
