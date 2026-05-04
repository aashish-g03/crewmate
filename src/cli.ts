import { cmdInit } from './commands/init.ts';
import { cmdUp } from './commands/up.ts';
import { cmdSend } from './commands/send.ts';
import { cmdCancel } from './commands/cancel.ts';
import { cmdList } from './commands/list.ts';
import { cmdStatus } from './commands/status.ts';
import { cmdTail } from './commands/tail.ts';
import { cmdDoctor } from './commands/doctor.ts';
import { cmdInstallClaudeAgent } from './commands/install-claude-agent.ts';
import { cmdWatch } from './commands/watch.ts';
import { cmdMcp } from './commands/mcp.ts';
import {
  cmdContextDestroy,
  cmdContextList,
  cmdContextPurge,
  cmdContextShow,
} from './commands/context.ts';

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') break;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function printHelp(): void {
  process.stdout.write(`crewmate — localhost agent-mesh CLI

Usage:
  crewmate init                                      Create ~/.crewmate and seed built-in agents
  crewmate doctor [--json]                           Report which agents have their CLI binary ready
  crewmate list                                      List initialized agents (with readiness)
  crewmate up <agent> [--workers=N]                  Start a supervised pool (blocking)
  crewmate up --all [--workers=N]                    Start every ready agent's pool in parallel
  crewmate send <agent> <prompt> [--timeout=ms] [--cwd=path]
                            [--context=<id> | --new-context [--owner-hint=<tag>] [--ttl-ms=N]]
                                                     Drop a task and wait for a TaskResult JSON
  crewmate cancel <agent> <taskId>                   Write a cancel sentinel
  crewmate status [<agent>]                          Show queue depth per agent
  crewmate tail [<agent>]                            Follow ~/.crewmate/log.jsonl (mesh-wide events)
  crewmate watch [<agent>|<taskId>]                  Tail per-task stdout/stderr logs across workers
  crewmate context list [<agent>] [--json]           List active contexts
  crewmate context show <contextId> [--tail=N | --turn=N] [--agent=<name>]
                                                     Inspect a transcript
  crewmate context destroy <contextId> [--agent=<name>]
                                                     Archive a context (reversible until purge)
  crewmate context purge --older-than=<duration> [--agent=<name>]
                                                     Permanently delete archived contexts
  crewmate install-claude-agent [--global|--project] [--force]
                                                     Drop crewmate.md into Claude Code's agents dir
  crewmate install-claude-agent --uninstall [--global|--project]
                                                     Remove the installed crewmate subagent
  crewmate mcp                                       Run the MCP server on stdio (for \`claude mcp add\`)

Environment:
  CREWMATE_HOME   Override ~/.crewmate location (useful for tests)
`);
}

function printContextHelp(): void {
  process.stdout.write(`crewmate context — manage agent conversation contexts

Usage:
  crewmate context list [<agent>] [--json]              List active contexts
  crewmate context show <contextId> [--tail=N | --turn=N] [--agent=<name>]
                                                        Inspect a transcript
  crewmate context destroy <contextId> [--agent=<name>] Archive a context
  crewmate context purge --older-than=<duration> [--agent=<name>]
                                                        Permanently delete archived contexts
`);
}

/** Parse a flag that should be a positive integer, or exit 2. */
function parsePositiveInt(
  raw: string | true | undefined,
  flagName: string
): number | undefined {
  if (raw === undefined) return undefined;
  if (raw === true) {
    process.stderr.write(`Invalid --${flagName}: missing value\n`);
    process.exit(2);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    process.stderr.write(`Invalid --${flagName}: ${String(raw)}\n`);
    process.exit(2);
  }
  return n;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    printHelp();
    return;
  }

  const { positional, flags } = parseArgs(rest);

  switch (cmd) {
    case 'init':
      await cmdInit();
      return;
    case 'doctor':
      await cmdDoctor({ json: flags.json === true });
      return;
    case 'up': {
      const workersRaw = flags.workers;
      const workers =
        typeof workersRaw === 'string' ? Number(workersRaw) : undefined;
      if (workers !== undefined && (!Number.isFinite(workers) || workers <= 0)) {
        process.stderr.write(`Invalid --workers: ${String(workersRaw)}\n`);
        process.exit(2);
      }
      await cmdUp(positional[0], { workers, all: flags.all === true });
      return;
    }
    case 'send': {
      const timeoutRaw = flags.timeout;
      const timeoutMs =
        typeof timeoutRaw === 'string' ? Number(timeoutRaw) : 300_000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        process.stderr.write(`Invalid --timeout: ${String(timeoutRaw)}\n`);
        process.exit(2);
      }
      const cwd = typeof flags.cwd === 'string' ? flags.cwd : undefined;
      const contextId =
        typeof flags.context === 'string' ? flags.context : undefined;
      const newContext = flags['new-context'] === true;
      const ownerHint =
        typeof flags['owner-hint'] === 'string'
          ? flags['owner-hint']
          : undefined;
      const ttlMs = parsePositiveInt(flags['ttl-ms'], 'ttl-ms');
      await cmdSend(positional[0], positional[1], {
        timeoutMs,
        cwd,
        contextId,
        newContext,
        ownerHint,
        ttlMs,
      });
      return;
    }
    case 'cancel':
      await cmdCancel(positional[0], positional[1]);
      return;
    case 'list':
      await cmdList();
      return;
    case 'status':
      await cmdStatus(positional[0]);
      return;
    case 'tail':
      await cmdTail(positional[0]);
      return;
    case 'watch':
      await cmdWatch(positional[0]);
      return;
    case 'context': {
      const sub = positional[0];
      if (!sub) {
        printContextHelp();
        process.exit(2);
      }
      const subPositional = positional.slice(1);
      switch (sub) {
        case 'list': {
          const agentArg = subPositional[0];
          await cmdContextList(agentArg, { json: flags.json === true });
          return;
        }
        case 'show': {
          const contextId = subPositional[0];
          const agentFlag =
            typeof flags.agent === 'string' ? flags.agent : undefined;
          const tail = parsePositiveInt(flags.tail, 'tail');
          const turn = parsePositiveInt(flags.turn, 'turn');
          await cmdContextShow(contextId, {
            agent: agentFlag,
            tail,
            turn,
          });
          return;
        }
        case 'destroy': {
          const contextId = subPositional[0];
          const agentFlag =
            typeof flags.agent === 'string' ? flags.agent : undefined;
          await cmdContextDestroy(contextId, { agent: agentFlag });
          return;
        }
        case 'purge': {
          const olderThan =
            typeof flags['older-than'] === 'string'
              ? flags['older-than']
              : undefined;
          const agentFlag =
            typeof flags.agent === 'string' ? flags.agent : undefined;
          await cmdContextPurge({ olderThan, agent: agentFlag });
          return;
        }
        default:
          process.stderr.write(`Unknown context subcommand: ${sub}\n\n`);
          printContextHelp();
          process.exit(2);
      }
    }
    case 'install-claude-agent': {
      const scope: 'global' | 'project' =
        flags.project === true ? 'project' : 'global';
      await cmdInstallClaudeAgent({
        scope,
        uninstall: flags.uninstall === true,
        force: flags.force === true,
      });
      return;
    }
    case 'mcp':
      await cmdMcp();
      return;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n`);
      printHelp();
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`[crewmate] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
