#!/usr/bin/env bun
/**
 * Mock ACP server for testing crewmate's ACP transport layer.
 *
 * Speaks JSON-RPC 2.0 over stdin/stdout, implements just enough of the
 * ACP protocol to exercise: initialize, sessions/create, sessions/message.
 *
 * Sessions track turn count in-memory. Each message response echoes the
 * prompt prefixed with the session ID and turn number, so tests can
 * assert on session reuse and turn counting.
 */

import * as readline from 'node:readline';

const sessions = new Map<string, { turnCount: number; cwd?: string }>();
let nextSessionNum = 1;
let initialized = false;

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

function handleRequest(id: number, method: string, params: Record<string, unknown>): void {
  switch (method) {
    case 'initialize': {
      respond(id, {
        protocolVersion: '1',
        agentInfo: { name: 'mock-acp-server', version: '0.0.1' },
        agentCapabilities: {
          sessionCapabilities: {},
          promptCapabilities: {},
        },
      });
      break;
    }

    case 'session/new': {
      if (!initialized) {
        respondError(id, -32600, 'Not initialized');
        return;
      }
      const sessionId = `mock_session_${nextSessionNum++}`;
      const cwd = typeof params.cwd === 'string' ? params.cwd : undefined;
      sessions.set(sessionId, { turnCount: 0, cwd });
      respond(id, { sessionId });
      break;
    }

    case 'session/prompt': {
      if (!initialized) {
        respondError(id, -32600, 'Not initialized');
        return;
      }
      const sessionId = params.sessionId as string;
      const session = sessions.get(sessionId);
      if (!session) {
        respondError(id, -32602, `Unknown session: ${sessionId}`);
        return;
      }
      session.turnCount++;
      const promptBlocks = params.prompt as Array<{ type?: string; text?: string }> | undefined;
      const promptText = promptBlocks?.map(b => b.text ?? '').join('') ?? '';
      const responseContent = `[${sessionId}:turn${session.turnCount}] ${promptText}`;
      // Stream content via notification (like real Gemini ACP)
      const notif = JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: responseContent },
          },
        },
      });
      process.stdout.write(notif + '\n');
      respond(id, { stopReason: 'end_turn' });
      break;
    }

    default:
      respondError(id, -32601, `Method not found: ${method}`);
  }
}

function handleNotification(method: string, _params: Record<string, unknown>): void {
  if (method === 'notifications/initialized') {
    initialized = true;
    process.stderr.write('[mock-acp] initialized\n');
  }
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
