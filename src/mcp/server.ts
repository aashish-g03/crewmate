import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { log, closeLogger } from '../logger.ts';
import {
  handleSendAndWait,
  sendAndWaitInputShape,
} from './tools/send-and-wait.ts';
import { handleListAgents } from './tools/list-agents.ts';
import { handleStatus, statusInputShape } from './tools/status.ts';
import { handleCancel, cancelInputShape } from './tools/cancel.ts';
import {
  handleNewContext,
  newContextInputShape,
} from './tools/new-context.ts';
import {
  handleListContexts,
  listContextsInputShape,
} from './tools/list-contexts.ts';
import {
  handleDestroyContext,
  destroyContextInputShape,
} from './tools/destroy-context.ts';
import {
  handleShowContext,
  showContextInputShape,
} from './tools/show-context.ts';
import {
  purgeArchivedHandler,
  purgeArchivedInputShape,
} from './tools/purge-archived.ts';

/**
 * Read the package version once at startup, fall back to '0.0.0' if
 * package.json can't be located (e.g. unusual install layouts). Kept tiny
 * so the MCP server boot stays under a few ms of overhead.
 */
async function readPackageVersion(): Promise<string> {
  try {
    const here = fileURLToPath(new URL('.', import.meta.url));
    // src/mcp/ -> ../../ = project root
    const pkgPath = path.resolve(here, '..', '..', 'package.json');
    const raw = await fs.readFile(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export async function runMcpServer(): Promise<void> {
  const version = await readPackageVersion();
  const server = new McpServer(
    { name: 'crewmate', version },
    { capabilities: { logging: {}, tools: {} } }
  );

  server.registerTool(
    'crewmate_send_and_wait',
    {
      title: 'Send a task to a crewmate agent and wait for the result',
      description:
        'Drop a task into the named agent\'s inbox and block until a TaskResult ' +
        'is written to its outbox. Emits MCP progress notifications while waiting ' +
        '(queued, claimed, periodic heartbeats). Returns the agent\'s stdout as ' +
        'text content plus the full TaskResult JSON as structured content.',
      inputSchema: sendAndWaitInputShape,
    },
    async (args, extra) => handleSendAndWait(args, extra)
  );

  server.registerTool(
    'crewmate_list_agents',
    {
      title: 'List initialized crewmate agents and readiness',
      description:
        'Return every initialized agent under ~/.crewmate plus whether its ' +
        'underlying CLI binary is on PATH. Useful for routing decisions.',
    },
    async () => handleListAgents()
  );

  server.registerTool(
    'crewmate_status',
    {
      title: 'Inspect crewmate task / agent state',
      description:
        'If a taskId is given, return the state and owning agent for that task. ' +
        'Otherwise, return per-agent queue counts. Pure filesystem reads, no spawning.',
      inputSchema: statusInputShape,
    },
    async (args) => handleStatus(args)
  );

  server.registerTool(
    'crewmate_cancel',
    {
      title: 'Write a cancel sentinel for a crewmate task',
      description:
        'Write cancel/<taskId> in the owning agent\'s tree. The agent\'s worker ' +
        'will SIGTERM the in-flight CLI run, then SIGKILL after 2s.',
      inputSchema: cancelInputShape,
    },
    async (args) => handleCancel(args)
  );

  // ─── v1.1: context-management tools ─────────────────────────────────────────
  // Persistent worker contexts (multi-turn sessions) live under
  // ~/.crewmate/<agent>/contexts/<id>/. These four tools let an MCP host
  // mint, list, inspect, and archive them without going through send_and_wait.

  server.registerTool(
    'crewmate_new_context',
    {
      title: 'Mint a new persistent worker context',
      description:
        'Mint a new persistent worker context without sending a task. ' +
        'Returns the contextId, useful when you want to establish a session ' +
        'before the first delegation.',
      inputSchema: newContextInputShape,
    },
    async (args) => handleNewContext(args)
  );

  server.registerTool(
    'crewmate_list_contexts',
    {
      title: 'List active worker contexts',
      description:
        'List active worker contexts. Pass `agent` to filter to one worker, ' +
        'omit to see all. Returns one entry per context with id, turn count, ' +
        'age, owner hint, and current affinity holder if any.',
      inputSchema: listContextsInputShape,
    },
    async (args) => handleListContexts(args)
  );

  server.registerTool(
    'crewmate_destroy_context',
    {
      title: 'Archive a worker context',
      description:
        'Archive a context. Workers can no longer add turns to it; it remains ' +
        'on disk under .archived/ until purged.',
      inputSchema: destroyContextInputShape,
    },
    async (args) => handleDestroyContext(args)
  );

  server.registerTool(
    'crewmate_show_context',
    {
      title: 'Return the full transcript of a context',
      description:
        'Return the full transcript of a context. Useful for self-inspection — ' +
        'the orchestrator can check "did I already ask about X?" without ' +
        're-querying the worker. Pass `tail` or `turn` to limit output.',
      inputSchema: showContextInputShape,
    },
    async (args) => handleShowContext(args)
  );

  server.registerTool(
    'crewmate_purge_archived',
    {
      title: 'Permanently delete archived contexts older than a threshold',
      description:
        'Permanently delete archived (TTL-expired or explicitly destroyed) ' +
        'contexts whose lastUsed is older than now-<olderThan>. Mirrors the ' +
        'Bash `crewmate context purge --older-than=<duration>` subcommand. ' +
        'Use "0s" to flush everything in `.archived/`. This is the only ' +
        'permanent-delete operation in the mesh — `destroy_context` only ' +
        'archives.',
      inputSchema: purgeArchivedInputShape,
    },
    async (args) => purgeArchivedHandler(args)
  );

  const transport = new StdioServerTransport();

  // Graceful shutdown so we flush the NDJSON log on Ctrl-C / Claude Code disconnect.
  const shutdown = async (signal: string): Promise<void> => {
    log({ event: 'mcp_server_stopped', message: `signal=${signal}` });
    try {
      await server.close();
    } catch {
      // already closed; ignore
    }
    await closeLogger();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await server.connect(transport);
  log({ event: 'mcp_server_started', message: `crewmate v${version} on stdio` });
}
