#!/usr/bin/env node
// Standalone end-to-end check: drives the real crewmate CLI against the real `codex` and `agy`.
// No fakes. Usage: node scripts/e2e-check.mjs [--vendors codex,gemini] [--keep] [--report <path>]
// Writes a PASS/FAIL/SKIP report (default docs/release/1.0.0-e2e.md) and exits 1 on any FAIL.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findOnPath } from '../plugins/crewmate/lib/vendors/index.mjs';
import { isAlive } from '../plugins/crewmate/lib/liveness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'plugins/crewmate/bin/crewmate');
const BINARY = { codex: 'codex', gemini: 'agy' };

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const vendors = (opt('--vendors') ?? 'codex,gemini').split(',').map((v) => v.trim()).filter(Boolean);
const keep = argv.includes('--keep');
const reportPath = path.resolve(ROOT, opt('--report') ?? 'docs/release/1.0.0-e2e.md');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crewmate-e2e-')));
const repo = path.join(tmp, 'repo');
const home = path.join(tmp, 'home');
fs.mkdirSync(repo);
fs.mkdirSync(home);
const env = { ...process.env, CREWMATE_HOME: home };

/** @type {{check: string, vendor: string, status: 'PASS'|'FAIL'|'SKIP', evidence: string, ms: number}[]} */
const rows = [];

/** Run the real CLI. */
function cli(args, { input, timeoutMs = 900_000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [BIN, ...args], { cwd: repo, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - t0 });
    });
    child.stdin.end(input ?? '');
  });
}

const json = (s) => JSON.parse(s.trim().split('\n').at(-1));
const jobDir = (id) => {
  const ws = fs.readdirSync(path.join(home, '.crewmate', 'workspaces'))[0];
  return path.join(home, '.crewmate', 'workspaces', ws, 'jobs', id);
};
const events = (id) => {
  try {
    return fs.readFileSync(path.join(jobDir(id), 'events.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const readJobFile = (id) => JSON.parse(fs.readFileSync(path.join(jobDir(id), 'job.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Record one check. `fn` returns evidence (string) or throws with the reason. */
async function check(name, vendor, fn) {
  const t0 = Date.now();
  if (vendor === '-' ? !available.length : !available.includes(vendor)) {
    const why = vendor === '-' ? `no vendor CLI on PATH (${vendors.map((v) => BINARY[v]).join(', ')})` : `${BINARY[vendor]} not on PATH`;
    rows.push({ check: name, vendor, status: 'SKIP', evidence: why, ms: 0 });
    process.stderr.write(`SKIP ${name} [${vendor}] ${why}\n`);
    return;
  }
  try {
    const evidence = await fn();
    rows.push({ check: name, vendor, status: 'PASS', evidence: String(evidence ?? ''), ms: Date.now() - t0 });
  } catch (err) {
    rows.push({ check: name, vendor, status: 'FAIL', evidence: String(err?.message ?? err), ms: Date.now() - t0 });
  }
  process.stderr.write(`${rows.at(-1).status} ${name} [${vendor}] ${rows.at(-1).evidence.slice(0, 120)}\n`);
}
function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---- fixture repo ----
fs.writeFileSync(
  path.join(repo, 'calc.js'),
  `// Sum the numbers 1..n.\nexport function sumTo(n) {\n  let total = 0;\n  for (let i = 1; i < n; i++) {\n    total += i;\n  }\n  return total;\n}\n`,
);
const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
git('init', '-q');
git('add', '.');
git('-c', 'user.email=e2e@crewmate', '-c', 'user.name=e2e', 'commit', '-q', '-m', 'calc');

const available = vendors.filter((v) => findOnPath(BINARY[v], env));
const versions = Object.fromEntries(
  vendors.map((v) => {
    const b = BINARY[v];
    const r = findOnPath(b, env) ? spawnSync(b, ['--version'], { encoding: 'utf8', timeout: 10_000 }) : null;
    return [v, r?.stdout?.trim().split('\n')[0] ?? 'not installed'];
  }),
);
const askIds = {};

// 1. setup
await check('setup reports ready', '-', async () => {
  const r = await cli(['setup', '--json'], { timeoutMs: 120_000 });
  const body = json(r.stdout);
  for (const v of available) expect(body.vendors[v].ready, `${v} not ready: ${body.vendors[v].fix}`);
  expect(r.code === 0, `exit ${r.code}`);
  return `exit 0; ready: ${available.join(', ')}`;
});

for (const v of vendors) {
  // 2. foreground ask
  await check('foreground ask', v, async () => {
    const r = await cli(['ask', v, 'In one sentence, what does calc.js do?']);
    const id = r.stdout.split('\n')[0].trim();
    askIds[v] = id;
    expect(r.code === 0, `exit ${r.code}: ${r.stdout.slice(-300)}${r.stderr}`);
    const res = json((await cli(['result', id, '--json'])).stdout);
    expect(res.job.state === 'done' && res.answer.trim(), `state ${res.job.state}, answer ${res.answer.length} bytes`);
    const ev = events(id);
    expect(ev[0]?.type === 'started' && ev.at(-1)?.type === 'end', 'events do not start with started / end with end');
    expect(ev.some((e) => e.type === 'tool' || e.type === 'note'), 'no tool or note events');
    return `exit 0 in ${Math.round(r.ms / 1000)}s; ${ev.length} events; answer: "${res.answer.trim().slice(0, 100)}"`;
  });

  // 3. detach + watch
  await check('detach then watch', v, async () => {
    const t0 = Date.now();
    const r = await cli(['ask', v, '--detach', 'List the function names defined in calc.js.']);
    const detachMs = Date.now() - t0;
    const id = r.stdout.trim();
    askIds[v] = id; // the newest ask job: what a bare --resume continues
    expect(r.code === 0 && detachMs < 2000, `ask --detach took ${detachMs}ms, exit ${r.code}`);
    const w = await cli(['watch', id]);
    const lines = w.stdout.trim().split('\n');
    expect(w.code === 0, `watch exit ${w.code}: ${w.stdout.slice(-300)}`);
    expect(lines.length >= 2 && /■ done/.test(lines.at(-1)), `lines: ${lines.join(' | ').slice(0, 300)}`);
    return `id in ${detachMs}ms; watch printed ${lines.length} lines, last: ${lines.at(-1)}`;
  });

  // 4. resume
  await check('resume', v, async () => {
    expect(askIds[v], 'no earlier ask job to resume');
    const r = await cli(['ask', v, '--resume', 'What file did you just describe? Answer with the file name only.']);
    const id = r.stdout.split('\n')[0].trim();
    expect(r.code === 0, `exit ${r.code}: ${r.stdout.slice(-300)}`);
    const res = json((await cli(['result', id, '--json'])).stdout);
    expect(/calc\.js/.test(res.answer), `answer does not mention calc.js: ${res.answer.slice(0, 200)}`);
    expect(res.job.flags.resumeConversationId === readJobFile(askIds[v]).vendorConversationId, 'did not reuse the conversation id');
    return `answer: "${res.answer.trim().slice(0, 80)}"`;
  });

  // 5. read-only holds
  await check('read-only blocks writes', v, async () => {
    const file = path.join(repo, `made-by-${v}.txt`);
    const r = await cli(['ask', v, `Create a file named made-by-${v}.txt containing hi in the current directory.`]);
    const id = r.stdout.split('\n')[0].trim();
    expect(!fs.existsSync(file), `${file} was created`);
    const res = json((await cli(['result', id, '--json'])).stdout);
    const o = res.job.outcome ?? {};
    return `file not created; state ${res.job.state}; denied: ${o.deniedTools?.join(', ') || 'none'}; tool errors: ${o.toolErrors?.length ?? 0}; answer: "${res.answer.trim().slice(0, 80)}"`;
  });
}

// 6. write + lock (codex)
await check('write job edits; second writer refused', 'codex', async () => {
  const r = await cli(['ask', 'codex', '--write', '--detach', 'Fix the off-by-one bug in calc.js so sumTo(n) includes n. Change only that line.']);
  const id = r.stdout.trim();
  expect(r.code === 0, `exit ${r.code}: ${r.stderr}`);
  const second = await cli(['ask', 'codex', '--write', 'x']);
  expect(second.code === 6, `second writer exit ${second.code}, expected 6`);
  const w = await cli(['watch', id]);
  expect(w.code === 0, `watch exit ${w.code}: ${w.stdout.slice(-300)}`);
  const diff = git('diff', '--quiet');
  expect(diff.status === 1, 'calc.js unchanged');
  return `second writer exit 6; job done; calc.js changed: ${git('diff', '--stat').stdout.trim()}`;
});

for (const v of vendors) {
  // 7. cancel
  await check('cancel mid-run', v, async () => {
    const r = await cli(['ask', v, '--detach', 'Read every file in this repository and explain each one in great detail, line by line.']);
    const id = r.stdout.trim();
    for (let i = 0; i < 240 && !events(id).some((e) => e.type === 'tool' || e.type === 'note'); i++) await sleep(250);
    const c = await cli(['cancel', id]);
    expect(c.code === 0, `cancel exit ${c.code}`);
    const w = await cli(['watch', id]);
    expect(w.code === 5, `watch exit ${w.code}, expected 5: ${w.stdout.slice(-200)}`);
    const job = readJobFile(id);
    await sleep(500);
    expect(!isAlive(job.runner) && !isAlive(job.vendorProcess), 'runner or vendor still alive');
    if (job.vendorProcess) {
      let groupGone = false;
      try {
        process.kill(-job.vendorProcess.pid, 0);
      } catch {
        groupGone = true;
      }
      expect(groupGone, 'vendor process group still has members');
    }
    return `canceled after first event; watch exit 5; runner and vendor group gone`;
  });
}

// 8. critique --diff
await check('critique --diff', '-', async () => {
  if (git('diff', '--quiet').status === 0) fs.appendFileSync(path.join(repo, 'calc.js'), '// trailing note\n');
  const r = await cli(['critique', '--diff']);
  const ids = r.stdout.trim().split('\n').filter(Boolean);
  expect(r.code === 0 && ids.length === available.length, `exit ${r.code}, ${ids.length} ids`);
  const w = await cli(['watch', ...ids]);
  const results = [];
  for (const id of ids) {
    const res = json((await cli(['result', id, '--json'])).stdout);
    results.push(`${res.job.vendor}: ${res.job.state}, ${res.answer.length} bytes`);
    expect(res.answer.trim(), `${res.job.vendor} empty critique (${res.job.state}: ${res.job.reason})`);
  }
  expect(w.code === 0, `watch exit ${w.code}`);
  return results.join('; ');
});

// 9. status
await check('status lists every job, all final', '-', async () => {
  const s = JSON.parse((await cli(['status', '--json'])).stdout);
  const running = s.filter((j) => !['done', 'failed', 'timeout', 'canceled'].includes(j.state));
  expect(running.length === 0, `still running: ${running.map((j) => j.id).join(', ')}`);
  return `${s.length} jobs, all final (${[...new Set(s.map((j) => j.state))].join(', ')})`;
});

// ---- report ----
const fails = rows.filter((r) => r.status === 'FAIL').length;
const lines = [
  '# crewmate 1.0.0 end-to-end check',
  '',
  `Run: ${new Date().toISOString()} on ${os.platform()} ${os.release()}, Node ${process.versions.node}.`,
  `CLIs: ${Object.entries(versions).map(([v, ver]) => `${v} → ${ver}`).join('; ')}.`,
  `Command: \`node scripts/e2e-check.mjs ${argv.join(' ')}\`. Real CLIs, no fakes; throwaway repo and CREWMATE_HOME under ${keep ? tmp : 'a temp folder (removed)'}.`,
  '',
  `Result: **${fails ? `${fails} FAIL` : 'all checks passed or skipped'}** (${rows.filter((r) => r.status === 'PASS').length} pass, ${fails} fail, ${rows.filter((r) => r.status === 'SKIP').length} skip).`,
  '',
  '| Check | Vendor | Result | Time | Evidence |',
  '|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.check} | ${r.vendor} | ${r.status} | ${Math.round(r.ms / 1000)}s | ${r.evidence.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`),
  '',
];
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, lines.join('\n'));
process.stderr.write(`report: ${reportPath}\n`);
if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
process.exitCode = fails ? 1 : 0;
