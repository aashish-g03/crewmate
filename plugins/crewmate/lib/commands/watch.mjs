// `crewmate watch <id...> [--since=<n>]`: print job events as lines until every job is final.
import { parseArgs } from '../vendored/args.mjs';
import { UsageError, assertName } from '../names.mjs';
import { resolveWorkspace } from '../workspace.mjs';
import { readJob, jobDir } from '../jobs.mjs';
import { readEvents } from '../events.mjs';
import { effectiveState, isAlive } from '../liveness.mjs';
import { extractOptionalValues } from './ask.mjs';

const POLL_MS = 250;
const MERGE_FLUSH_MS = 2000;
const NOTE_EVERY_MS = 2000;
const EXIT = { done: 0, failed: 1, timeout: 4, canceled: 5 };
const RANK = { failed: 3, timeout: 2, canceled: 1, done: 0 };
const FINAL = ['done', 'failed', 'timeout', 'canceled'];

/** @param {any} job @param {string} state */
function endLine(job, state, reason, n) {
  const started = Date.parse(job.startedAt ?? job.createdAt);
  const ended = Date.parse(job.endedAt ?? new Date().toISOString());
  const secs = Math.max(0, Math.round((ended - started) / 1000));
  const parts = [`■ ${state}${reason ? ` — ${reason}` : ''} in ${secs}s`];
  const o = job.outcome;
  if (o?.usage) parts.push(`${o.usage.input} in / ${o.usage.output} out tokens`);
  if (o?.deniedTools?.length) parts.push(`denied: ${o.deniedTools.join(', ')}`);
  if (o?.toolErrors?.length) parts.push(`tool errors: ${o.toolErrors.length}`);
  return { n, text: parts.join('; ') };
}

/**
 * Brief mode (for Claude Code's Monitor, where every line wakes Claude): the start, errors at once,
 * one progress summary per interval, and the end.
 */
function makeBriefFormatter(label, write, everyMs) {
  let steps = 0;
  let lastSummarizedSteps = 0;
  let lastSummaryAt = Date.now();
  let last = '';
  let lastN = 0;
  const out = (n, text) => write(`${label} #${n} ${text}\n`);
  return {
    flush() {},
    tick(now) {
      if (steps > lastSummarizedSteps && now - lastSummaryAt >= everyMs) {
        out(lastN, `… ${steps} tool steps so far, last: ${last}`);
        lastSummarizedSteps = steps;
        lastSummaryAt = now;
      }
    },
    event(ev, now) {
      lastN = ev.n;
      if (ev.type === 'started') return out(ev.n, `● started${ev.model ? ` (${ev.model})` : ''}`);
      if (ev.type === 'tool') {
        if (ev.phase === 'start') return;
        steps++;
        last = `${ev.name}${ev.target ? ` ${ev.target}` : ''}`;
        if (ev.phase === 'error') out(ev.n, `✗ ${last}`);
        return;
      }
      if (ev.type === 'note' && /^(error:|continuing)/.test(String(ev.text))) out(ev.n, `… ${ev.text}`);
    },
  };
}

/** One job's line formatter with merging and note throttling. */
function makeFormatter(label, write) {
  /** @type {{name: string, count: number, n: number, at: number}|null} */
  let run = null;
  let lastNoteAt = 0;
  let droppedNotes = 0;
  const out = (n, text) => {
    const extra = droppedNotes ? ` (+${droppedNotes} notes)` : '';
    droppedNotes = 0;
    write(`${label} #${n} ${text}${extra}\n`);
  };
  const flush = () => {
    if (!run) return;
    out(run.n, run.count > 1 ? `✓ ${run.name} ×${run.count}` : `✓ ${run.name}`);
    run = null;
  };
  return {
    flush,
    tick(now) {
      if (run && now - run.at >= MERGE_FLUSH_MS) flush();
    },
    /** @param {any} ev @param {number} now */
    event(ev, now) {
      if (ev.type === 'tool') {
        if (ev.phase === 'start') {
          if (run && run.name === ev.name) return;
          flush();
          out(ev.n, `▶ ${ev.name}${ev.target ? ` ${ev.target}` : ''}`);
          return;
        }
        if (ev.phase === 'done') {
          if (run && run.name === ev.name) {
            run.count++;
            run.n = ev.n;
            return;
          }
          flush();
          run = { name: ev.name, count: 1, n: ev.n, at: now };
          return;
        }
        flush();
        out(ev.n, `✗ ${ev.name}${ev.target ? ` ${ev.target}` : ''}`);
        return;
      }
      if (ev.type === 'note') {
        const isError = /^error:/.test(String(ev.text));
        if (!isError && now - lastNoteAt < NOTE_EVERY_MS) {
          droppedNotes++;
          return;
        }
        flush();
        lastNoteAt = now;
        out(ev.n, `… ${ev.text}`);
        return;
      }
      if (ev.type === 'started') {
        flush();
        out(ev.n, `● started${ev.model ? ` (${ev.model})` : ''}`);
        return;
      }
      if (ev.type === 'usage' || ev.type === 'end') return; // shown on the end line
    },
  };
}

/** @param {string[]} argv @param {any} io */
export async function run(argv, io) {
  const { found, rest } = extractOptionalValues(argv, ['since']);
  const { options, positionals } = parseArgs(rest, { booleanOptions: ['json', 'brief'] });
  if (!positionals.length) throw new UsageError('usage: crewmate watch <id...> [--since=<n>] [--brief] [--json]');
  const briefEvery = Number(io.env.CREWMATE_BRIEF_EVERY_MS ?? 60_000);
  const since = found.since === undefined || found.since === true ? 0 : Number(found.since);
  if (!Number.isInteger(since) || since < 0) throw new UsageError('--since needs a non-negative integer');
  const ws = resolveWorkspace(io.cwd, io.env);
  const ids = positionals.map((id) => assertName('job', id));
  for (const id of ids) {
    if (!readJob(ws, id)) {
      io.stderr.write(`crewmate: no such job: ${id}\n`);
      return 2;
    }
  }
  const multi = ids.length > 1;
  const write = (s) => io.stdout.write(s);
  const state = new Map(
    ids.map((id) => {
      const job = readJob(ws, id);
      const label = multi ? `${job.vendor}:${id.slice(-4)}` : job.vendor;
      const fmt = options.brief ? makeBriefFormatter(label, write, briefEvery) : makeFormatter(label, write);
      return [id, { lastN: since, done: false, final: null, label, fmt }];
    }),
  );

  /** Print the closing line (or JSON end event) for one job and mark it done. */
  const finish = (s, job, finalState, reason, endEvent) => {
    s.fmt.flush();
    if (options.json) {
      write(`${JSON.stringify(endEvent ?? { n: s.lastN + 1, type: 'end', state: finalState, reason, outcome: job?.outcome ?? null })}\n`);
    } else {
      const line = endLine(job ?? { createdAt: new Date().toISOString() }, finalState, reason, s.lastN);
      write(`${s.label} #${line.n} ${line.text}\n`);
    }
    s.done = true;
    s.final = finalState;
  };

  for (;;) {
    const now = Date.now();
    for (const id of ids) {
      const s = state.get(id);
      if (s.done) continue;
      const job = readJob(ws, id);
      if (!job) {
        // Folder removed (pruned or deleted by hand) while watching.
        finish(s, null, 'failed', 'job folder removed', null);
        continue;
      }
      let ended = null;
      for (const ev of readEvents(jobDir(ws, id), s.lastN)) {
        s.lastN = ev.n;
        if (ev.type === 'end') {
          ended = ev;
          break;
        }
        if (options.json) write(`${JSON.stringify(ev)}\n`);
        else s.fmt.event(ev, now);
      }
      if (!options.json) s.fmt.tick(now);
      if (ended) {
        finish(s, readJob(ws, id) ?? job, ended.state, ended.reason, ended);
        continue;
      }
      const eff = effectiveState(job);
      if (!FINAL.includes(eff.state)) continue;
      // Final with no new end event. A live runner is about to append it; otherwise (runner died,
      // job ended by `cancel`, or --since past the end line) report the stored final state.
      if (FINAL.includes(job.state) && isAlive(job.runner)) continue;
      finish(s, job, eff.state, eff.reason, null);
    }
    if ([...state.values()].every((s) => s.done)) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  const worst = [...state.values()].map((s) => s.final).sort((a, b) => RANK[b] - RANK[a])[0];
  return EXIT[worst] ?? 1;
}
