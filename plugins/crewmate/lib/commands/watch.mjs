// `crewmate watch <id...> [--since=<n>]`: print job events as lines until every job is final.
import { parseArgs } from '../vendored/args.mjs';
import { UsageError, assertName } from '../names.mjs';
import { resolveWorkspace } from '../workspace.mjs';
import { readJob, jobDir } from '../jobs.mjs';
import { readEvents } from '../events.mjs';
import { effectiveState } from '../liveness.mjs';
import { extractOptionalValues } from './ask.mjs';

const POLL_MS = 250;
const MERGE_FLUSH_MS = 2000;
const NOTE_EVERY_MS = 2000;
const EXIT = { done: 0, failed: 1, timeout: 4, canceled: 5 };
const RANK = { failed: 3, timeout: 2, canceled: 1, done: 0 };

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
        if (now - lastNoteAt < NOTE_EVERY_MS) {
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
  const { positionals } = parseArgs(rest, {});
  if (!positionals.length) throw new UsageError('usage: crewmate watch <id...> [--since=<n>]');
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
  const state = new Map(
    ids.map((id) => {
      const job = readJob(ws, id);
      const label = multi ? `${job.vendor}:${id.slice(-4)}` : job.vendor;
      return [id, { lastN: since, done: false, final: null, fmt: makeFormatter(label, (s) => io.stdout.write(s)), label }];
    }),
  );

  for (;;) {
    const now = Date.now();
    for (const id of ids) {
      const s = state.get(id);
      if (s.done) continue;
      const job = readJob(ws, id);
      const eff = effectiveState(job);
      const events = readEvents(jobDir(ws, id), s.lastN);
      let ended = null;
      for (const ev of events) {
        s.lastN = ev.n;
        if (ev.type === 'end') ended = ev;
        s.fmt.event(ev, now);
      }
      s.fmt.tick(now);
      const isFinal = ['done', 'failed', 'timeout', 'canceled'].includes(eff.state);
      if (ended || isFinal) {
        // A runner that ended normally writes `end` last; read once more so nothing is lost.
        if (!ended && job.state !== eff.state) {
          /* runner died without an end event */
        } else if (!ended) {
          continue; // stored final but end event not yet visible: next poll
        }
        s.fmt.flush();
        const finalState = ended ? ended.state : eff.state;
        const reason = ended ? ended.reason : eff.reason;
        const line = endLine(readJob(ws, id) ?? job, finalState, reason, s.lastN);
        io.stdout.write(`${s.label} #${line.n} ${line.text}\n`);
        s.done = true;
        s.final = finalState;
      }
    }
    if ([...state.values()].every((s) => s.done)) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  const worst = [...state.values()].map((s) => s.final).sort((a, b) => RANK[b] - RANK[a])[0];
  return EXIT[worst] ?? 1;
}
