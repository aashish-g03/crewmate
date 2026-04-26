import fs from 'node:fs/promises';
import path from 'node:path';
import {
  archivedContextsRoot,
  contextDir,
  contextsRoot,
  listAgentNames,
} from '../paths.ts';
import {
  archiveContext,
  ContextNotFoundError,
  listContextIds,
  purgeArchivedOlderThan,
  readAffinityHolder,
  readContextMeta,
  readContextTurns,
} from '../transports/mailbox.ts';
import type { ContextMeta, ContextTurn } from '../envelope.ts';

/**
 * `crewmate context …` subcommands. Inspect, archive, and purge per-agent
 * conversation contexts persisted under ~/.crewmate/<agent>/contexts/.
 *
 * Conventions:
 *   - Tabular output goes to stdout; status / not-found / summary lines go
 *     to stderr (mirrors the rest of the CLI).
 *   - --json toggles machine-readable output where applicable.
 *   - Exit code 2 = user error (bad input, not-found); 0 = success.
 *
 * Locating contexts: `--agent=<name>` short-circuits the search. Otherwise
 * we iterate every agent and find the one whose contextDir() exists. This
 * is O(agents) which is tiny on a single host; no need for an index.
 */

const CONTEXT_ID_REGEX = /^ctx_[a-z0-9]{8}$/;

interface ContextSummary {
  agent: string;
  contextId: string;
  turnCount: number;
  ageMs: number;
  ownerHint: string | null;
  lastUsed: string;
  totalBytes: number;
  affinityPid: number | null;
  ttlExceeded: boolean;
}

/**
 * Format a duration in ms as the largest reasonable unit pair, e.g.
 *   500       → '<1s'
 *   12_000    → '12s'
 *   312_000   → '5m12s' → trimmed to '5m'
 *   8_000_000 → '2h13m'
 *   86_400_000 * 3 + 4 * 3600_000 → '3d4h'
 *
 * Keeps the column tight: at most two units, no fractional values.
 */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 1000) return '<1s';
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day > 0) {
    const remHr = hr - day * 24;
    return remHr > 0 ? `${day}d${remHr}h` : `${day}d`;
  }
  if (hr > 0) {
    const remMin = min - hr * 60;
    return remMin > 0 ? `${hr}h${remMin}m` : `${hr}h`;
  }
  if (min > 0) {
    const remSec = sec - min * 60;
    return remSec > 0 ? `${min}m${remSec}s` : `${min}m`;
  }
  return `${sec}s`;
}

/**
 * Human-readable byte sizes — picks the largest unit at which the value is
 * >= 1.0. `1023 → '1023B'`, `1024 → '1KB'`, `1500000 → '1.4MB'`.
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n}B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)}KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)}MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)}GB`;
}

/**
 * Parse `7d`, `24h`, `30m`, `60s` into milliseconds. Returns null on any
 * unrecognized format — caller is responsible for reporting the error.
 *
 * `0s` (and `0d`/`0h`/`0m`) explicitly resolves to 0 so `--older-than=0s`
 * means "purge everything archived right now," which is useful for tests.
 */
export function parseDuration(raw: string): number | null {
  const m = /^(\d+)(s|m|h|d)$/.exec(raw.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = m[2]!;
  switch (unit) {
    case 's':
      return n * 1000;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 3_600_000;
    case 'd':
      return n * 86_400_000;
  }
  return null;
}

/**
 * Sum the size of every regular file inside a context directory.
 * Skips subdirectories defensively (none should exist today, but if they
 * did we'd miss them rather than crash on a stat).
 */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    try {
      const st = await fs.stat(path.join(dir, e.name));
      total += st.size;
    } catch {
      // Skip files that vanish mid-scan; not worth aborting the listing.
    }
  }
  return total;
}

/**
 * Collect summaries for every active (non-archived) context across one
 * agent or every agent. The per-context work is one meta read + one
 * dir-stat + one affinity check; cheap enough to do serially.
 */
async function collectSummaries(agentFilter?: string): Promise<ContextSummary[]> {
  const agents = agentFilter ? [agentFilter] : await listAgentNames();
  const out: ContextSummary[] = [];
  const now = Date.now();
  for (const agent of agents) {
    let ids: string[];
    try {
      ids = await listContextIds(agent);
    } catch {
      continue; // agent dir doesn't exist or isn't readable — skip
    }
    for (const id of ids) {
      let meta: ContextMeta;
      try {
        meta = await readContextMeta(agent, id);
      } catch {
        // Corrupt or partially-written meta — skip it. The lifecycle
        // sweeper will handle cleanup; we don't want list to crash.
        continue;
      }
      const totalBytes = await dirSize(contextDir(agent, id));
      const affinityPid = await readAffinityHolder(agent, id);
      const ageMs = now - new Date(meta.lastUsed).getTime();
      out.push({
        agent,
        contextId: id,
        turnCount: meta.turnCount,
        ageMs,
        ownerHint: meta.ownerHint ?? null,
        lastUsed: meta.lastUsed,
        totalBytes,
        affinityPid,
        ttlExceeded: ageMs >= meta.ttlMs,
      });
    }
  }
  return out;
}

/**
 * `crewmate context list [<agent>] [--json]` — table or JSON output of
 * every active context.
 */
export async function cmdContextList(
  agent?: string,
  opts: { json?: boolean } = {}
): Promise<void> {
  const summaries = await collectSummaries(agent);
  if (summaries.length === 0) {
    if (opts.json) {
      process.stdout.write('[]\n');
      return;
    }
    process.stderr.write('[crewmate] no active contexts.\n');
    return;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(summaries, null, 2) + '\n');
    return;
  }

  interface Row {
    agent: string;
    contextId: string;
    turns: string;
    age: string;
    ownerHint: string;
    bytes: string;
    affinity: string;
  }
  const rows: Row[] = summaries.map((s) => ({
    agent: s.agent,
    contextId: s.contextId,
    turns: String(s.turnCount),
    age: s.ttlExceeded ? `${formatAge(s.ageMs)} (TTL)` : formatAge(s.ageMs),
    ownerHint: s.ownerHint ?? '-',
    bytes: formatBytes(s.totalBytes),
    affinity: s.affinityPid !== null ? `pid=${s.affinityPid}` : '-',
  }));

  const wAgent = Math.max(5, ...rows.map((r) => r.agent.length));
  const wCtx = Math.max(10, ...rows.map((r) => r.contextId.length));
  const wTurns = Math.max(5, ...rows.map((r) => r.turns.length));
  const wAge = Math.max(3, ...rows.map((r) => r.age.length));
  const wHint = Math.max(10, ...rows.map((r) => r.ownerHint.length));
  const wBytes = Math.max(5, ...rows.map((r) => r.bytes.length));
  const wAff = Math.max(8, ...rows.map((r) => r.affinity.length));

  const header =
    `${'AGENT'.padEnd(wAgent)}  ${'CONTEXT_ID'.padEnd(wCtx)}  ` +
    `${'TURNS'.padEnd(wTurns)}  ${'AGE'.padEnd(wAge)}  ` +
    `${'OWNER_HINT'.padEnd(wHint)}  ${'BYTES'.padEnd(wBytes)}  ` +
    `${'AFFINITY'.padEnd(wAff)}\n`;
  const sep =
    `${'-'.repeat(wAgent)}  ${'-'.repeat(wCtx)}  ` +
    `${'-'.repeat(wTurns)}  ${'-'.repeat(wAge)}  ` +
    `${'-'.repeat(wHint)}  ${'-'.repeat(wBytes)}  ` +
    `${'-'.repeat(wAff)}\n`;
  process.stdout.write(header);
  process.stdout.write(sep);
  for (const r of rows) {
    process.stdout.write(
      `${r.agent.padEnd(wAgent)}  ${r.contextId.padEnd(wCtx)}  ` +
        `${r.turns.padEnd(wTurns)}  ${r.age.padEnd(wAge)}  ` +
        `${r.ownerHint.padEnd(wHint)}  ${r.bytes.padEnd(wBytes)}  ` +
        `${r.affinity.padEnd(wAff)}\n`
    );
  }
}

/**
 * Find which agent owns a given contextId. Returns null if no agent has it
 * in their active contexts dir. (Archived ones don't count for show/destroy.)
 */
async function findAgentForContext(
  contextId: string,
  agentHint?: string
): Promise<string | null> {
  if (agentHint) {
    try {
      await fs.access(contextDir(agentHint, contextId));
      return agentHint;
    } catch {
      return null;
    }
  }
  const agents = await listAgentNames();
  for (const a of agents) {
    try {
      await fs.access(contextDir(a, contextId));
      return a;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Reproduce the worker's transcript-construction shape for debugging. Must
 * stay in sync with `buildPrompt` in src/worker.ts — that's the source of
 * truth, this is a faithful copy. If they ever drift, the worker wins.
 */
function reconstructPrompt(turns: ContextTurn[]): string {
  if (turns.length === 0) {
    return 'Current turn:\nUser: <next prompt would go here>';
  }
  const N = turns.length + 1;
  const lines: string[] = [];
  lines.push(`This is turn ${N} of a continuing conversation. Prior turns:`);
  lines.push('');
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    lines.push(`Turn ${i + 1}:`);
    lines.push(`User: ${t.prompt}`);
    lines.push(`You: ${t.response}`);
    lines.push('');
  }
  lines.push('Current turn:');
  lines.push('User: <next prompt would go here>');
  return lines.join('\n');
}

/**
 * `crewmate context show <id> [--agent=…] [--tail=N | --turn=N]` — dump the
 * full transcript for a context, plus the reconstructed prompt that would
 * be sent for the next turn.
 */
export async function cmdContextShow(
  contextId: string | undefined,
  opts: { agent?: string; tail?: number; turn?: number } = {}
): Promise<void> {
  if (!contextId) {
    process.stderr.write(
      'Usage: crewmate context show <contextId> [--agent=<name>] [--tail=N | --turn=N]\n'
    );
    process.exit(2);
  }
  if (!CONTEXT_ID_REGEX.test(contextId)) {
    process.stderr.write(
      `Invalid contextId: must look like "ctx_xxxxxxxx" (got: ${contextId})\n`
    );
    process.exit(2);
  }
  if (opts.tail !== undefined && opts.turn !== undefined) {
    process.stderr.write(
      '[crewmate] --tail and --turn are mutually exclusive.\n'
    );
    process.exit(2);
  }
  if (opts.tail !== undefined && (!Number.isFinite(opts.tail) || opts.tail < 1)) {
    process.stderr.write(`Invalid --tail: must be a positive integer\n`);
    process.exit(2);
  }
  if (opts.turn !== undefined && (!Number.isFinite(opts.turn) || opts.turn < 1)) {
    process.stderr.write(`Invalid --turn: must be a positive integer\n`);
    process.exit(2);
  }

  const agent = await findAgentForContext(contextId, opts.agent);
  if (!agent) {
    process.stderr.write(`[crewmate] context not found: ${contextId}\n`);
    process.exit(2);
  }

  let meta: ContextMeta;
  let turns: ContextTurn[];
  try {
    meta = await readContextMeta(agent, contextId);
    turns = await readContextTurns(agent, contextId);
  } catch (err) {
    if (err instanceof ContextNotFoundError) {
      process.stderr.write(`[crewmate] context not found: ${contextId}\n`);
      process.exit(2);
    }
    throw err;
  }

  // Header block.
  const ageMs = Date.now() - new Date(meta.lastUsed).getTime();
  process.stdout.write(`context: ${meta.contextId}\n`);
  process.stdout.write(`agent:   ${meta.agent}\n`);
  process.stdout.write(`created: ${meta.created}\n`);
  process.stdout.write(
    `lastUsed: ${meta.lastUsed} (${formatAge(ageMs)} ago)\n`
  );
  process.stdout.write(`ownerHint: ${meta.ownerHint ?? '-'}\n`);
  process.stdout.write(`turns:   ${meta.turnCount}\n`);
  process.stdout.write(`ttlMs:   ${meta.ttlMs}\n`);
  process.stdout.write('\n');

  // Decide which turns to print.
  let toPrint: { index: number; turn: ContextTurn }[];
  if (opts.turn !== undefined) {
    const idx = opts.turn - 1;
    if (idx < 0 || idx >= turns.length) {
      process.stderr.write(
        `[crewmate] turn ${opts.turn} out of range (have ${turns.length}).\n`
      );
      process.exit(2);
    }
    toPrint = [{ index: idx, turn: turns[idx]! }];
  } else if (opts.tail !== undefined) {
    const start = Math.max(0, turns.length - opts.tail);
    toPrint = turns.slice(start).map((t, i) => ({ index: start + i, turn: t }));
  } else {
    toPrint = turns.map((t, i) => ({ index: i, turn: t }));
  }

  for (const { index, turn } of toPrint) {
    process.stdout.write(`--- Turn ${index + 1} ---\n`);
    process.stdout.write(`[${turn.timestamp}]  taskId=${turn.taskId}\n`);
    process.stdout.write(`USER: ${turn.prompt}\n`);
    process.stdout.write('\n');
    process.stdout.write(`YOU: ${turn.response}\n`);
    process.stdout.write('\n');
  }

  // Reconstructed prompt — uses the FULL turn history (not the filtered
  // toPrint set), since this is what the next turn would actually send.
  process.stdout.write('--- Reconstructed prompt for next turn ---\n');
  process.stdout.write(reconstructPrompt(turns));
  process.stdout.write('\n');
}

/**
 * `crewmate context destroy <id> [--agent=…]` — archive (NOT delete) a
 * context. To permanently remove, run `context purge` afterward.
 */
export async function cmdContextDestroy(
  contextId: string | undefined,
  opts: { agent?: string } = {}
): Promise<void> {
  if (!contextId) {
    process.stderr.write(
      'Usage: crewmate context destroy <contextId> [--agent=<name>]\n'
    );
    process.exit(2);
  }
  if (!CONTEXT_ID_REGEX.test(contextId)) {
    process.stderr.write(
      `Invalid contextId: must look like "ctx_xxxxxxxx" (got: ${contextId})\n`
    );
    process.exit(2);
  }
  const agent = await findAgentForContext(contextId, opts.agent);
  if (!agent) {
    process.stderr.write(`[crewmate] context not found: ${contextId}\n`);
    process.exit(2);
  }
  try {
    await archiveContext(agent, contextId, 'explicit');
  } catch (err) {
    if (err instanceof ContextNotFoundError) {
      process.stderr.write(`[crewmate] context not found: ${contextId}\n`);
      process.exit(2);
    }
    throw err;
  }
  process.stderr.write(`[crewmate] archived ${agent}/${contextId}\n`);
}

/**
 * `crewmate context purge --older-than=<duration> [--agent=<name>]` —
 * permanently delete archived contexts whose lastUsed is older than the
 * cutoff. `--older-than=0s` means "everything currently archived."
 *
 * Also drops the .archived/ root if it ends up empty, so future sweeps
 * don't trip on it.
 */
export async function cmdContextPurge(opts: {
  olderThan: string | undefined;
  agent?: string;
}): Promise<void> {
  if (!opts.olderThan) {
    process.stderr.write(
      'Usage: crewmate context purge --older-than=<duration> [--agent=<name>]\n' +
        '  duration is one of: <N>s, <N>m, <N>h, <N>d\n'
    );
    process.exit(2);
  }
  const ms = parseDuration(opts.olderThan);
  if (ms === null) {
    process.stderr.write(
      `Invalid --older-than: '${opts.olderThan}' (expected e.g. 7d, 24h, 30m, 60s)\n`
    );
    process.exit(2);
  }

  const agents = opts.agent ? [opts.agent] : await listAgentNames();
  let total = 0;
  for (const a of agents) {
    let purged = 0;
    try {
      purged = await purgeArchivedOlderThan(a, ms);
    } catch (err) {
      // Don't let one agent's purge failure stop the others — log and move on.
      process.stderr.write(
        `[crewmate] purge failed for ${a}: ${(err as Error).message}\n`
      );
      continue;
    }
    total += purged;
    // Best-effort: if .archived/ is now empty, remove it. Cosmetic, but
    // makes a clean "I just purged everything" feel actually clean.
    if (purged > 0) {
      const archRoot = archivedContextsRoot(a);
      try {
        const remaining = await fs.readdir(archRoot);
        if (remaining.length === 0) {
          await fs.rmdir(archRoot);
        }
      } catch {
        // ENOENT or non-empty — both fine to ignore here.
      }
    }
    // Also drop the contexts/ root if it's totally empty (no active, no
    // archived). Keeps `crewmate context list` returning the canonical
    // "no active contexts" message instead of an empty table.
    void contextsRoot; // (no cleanup at this layer; archive cleanup above is enough)
  }
  process.stderr.write(
    `[crewmate] purged ${total} archived context(s) older than ${opts.olderThan}\n`
  );
}
