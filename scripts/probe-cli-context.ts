#!/usr/bin/env bun
/**
 * End-to-end smoke test for v1.1 CLI context surface (Step 6).
 *
 * Spawns a real gemini-worker pool (poolSize=1 for determinism) under a
 * temp CREWMATE_HOME, then exercises:
 *
 *   - `crewmate send … --new-context --owner-hint=…`
 *   - `crewmate send … --context=<id>` continuation
 *   - mutual exclusion of --new-context and --context
 *   - bad --context format
 *   - `crewmate context list` (table + --json)
 *   - `crewmate context show <id>` (full + --tail)
 *   - `crewmate context show <bogus>` exits 2
 *   - `crewmate context destroy <id>` (archives, doesn't delete)
 *   - `crewmate context purge --older-than=0s` (drops the archive)
 *
 * Run: bun scripts/probe-cli-context.ts
 *
 * Budget: ~70-90 seconds — two real Gemini round-trips dominate.
 *
 * Exits 0 on success, 1 on first failure.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

// Set a temp CREWMATE_HOME *before* importing anything that resolves paths.
const TMP_HOME = path.join(
  os.tmpdir(),
  `crewmate-probe-cli-ctx-${process.pid}-${Date.now()}`
);
process.env.CREWMATE_HOME = TMP_HOME;
const HOME = TMP_HOME;

const PROJECT_ROOT = path.resolve(import.meta.dir, '..');
const CLI = path.join(PROJECT_ROOT, 'src/cli.ts');
const AGENT = 'gemini-worker';

function ok(label: string): void {
  console.log(`[OK] ${label}`);
}

function fail(label: string, err: unknown): never {
  console.error(`[FAIL] ${label}: ${(err as Error).message ?? String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `bun src/cli.ts <args…>` and capture stdout/stderr/exitCode.
 * Inherits CREWMATE_HOME from the probe's own env.
 */
async function runCli(args: string[], timeoutMs = 180_000): Promise<RunResult> {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    env: { ...process.env, CREWMATE_HOME: HOME },
    cwd: PROJECT_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* */
    }
  }, timeoutMs);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return { exitCode, stdout, stderr };
}

async function waitForFile(p: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(p);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`waitForFile timeout: ${p}`);
}

interface SendOutcome {
  taskId: string;
  contextId: string | null;
  turnNumber: number | null;
  result: string;
  status: string;
}

/** Parse a `crewmate send` stdout JSON dump (the result envelope). */
function parseSendStdout(stdout: string): SendOutcome {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error('crewmate send produced no stdout');
  const parsed = JSON.parse(trimmed) as {
    taskId: string;
    status: string;
    result: string;
    contextId?: string | null;
    turnNumber?: number;
  };
  return {
    taskId: parsed.taskId,
    contextId: parsed.contextId ?? null,
    turnNumber: parsed.turnNumber ?? null,
    result: parsed.result,
    status: parsed.status,
  };
}

async function main(): Promise<void> {
  console.log(`[probe] CREWMATE_HOME=${HOME}`);
  await fs.rm(HOME, { recursive: true, force: true });
  await fs.mkdir(HOME, { recursive: true });

  // 1. Init.
  {
    const r = await runCli(['init']);
    if (r.exitCode !== 0) {
      fail('crewmate init', new Error(`exit=${r.exitCode}\n${r.stderr}`));
    }
    ok('crewmate init');
  }

  // Override poolSize=1 for determinism.
  const configPath = path.join(HOME, AGENT, 'config.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({ poolSize: 1, timeoutMs: 120000 }, null, 2)
  );
  ok('config written (poolSize=1)');

  // 2. Spawn the pool.
  console.log('[probe] starting pool…');
  const pool = Bun.spawn(['bun', CLI, 'up', AGENT], {
    env: { ...process.env, CREWMATE_HOME: HOME },
    cwd: PROJECT_ROOT,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      pool.kill('SIGTERM');
      await Promise.race([
        pool.exited,
        new Promise((r) => setTimeout(r, 3000)),
      ]);
      try {
        pool.kill('SIGKILL');
      } catch {
        /* */
      }
    } catch {
      /* */
    }
  };
  process.on('exit', () => {
    void cleanup();
  });
  process.on('SIGINT', () => {
    void cleanup().then(() => process.exit(130));
  });

  try {
    // Wait for inbox/ to exist (proxy for "supervisor up").
    await waitForFile(path.join(HOME, AGENT, 'inbox'), 10_000);
    ok('inbox/ exists');
    // Give the worker chokidar watcher a moment to attach.
    await new Promise((r) => setTimeout(r, 1000));

    // 3. Test --new-context.
    const epoch = Date.now();
    console.log('[probe] sending turn 1 (--new-context)…');
    const r1 = await runCli([
      'send',
      AGENT,
      `Reply with exactly the single token: CTX_ONE_${epoch}`,
      '--new-context',
      '--owner-hint=probe-test',
      '--timeout=120000',
    ]);
    if (r1.exitCode !== 0) {
      fail(
        'turn 1 send',
        new Error(`exit=${r1.exitCode}\nstdout=${r1.stdout}\nstderr=${r1.stderr}`)
      );
    }
    const o1 = parseSendStdout(r1.stdout);
    assert(o1.status === 'completed', `turn 1 status='${o1.status}'`);
    assert(
      typeof o1.contextId === 'string' &&
        /^ctx_[a-z0-9]{8}$/.test(o1.contextId),
      `turn 1 contextId='${o1.contextId}' must be ctx_xxxxxxxx`
    );
    assert(o1.turnNumber === 1, `turn 1 turnNumber=${o1.turnNumber}`);
    assert(
      o1.result.includes(`CTX_ONE_${epoch}`),
      `turn 1 result missing token: ${o1.result.slice(0, 200)}`
    );
    // Stderr should advertise context+turn in the completion line.
    assert(
      r1.stderr.includes(`(context: ${o1.contextId}, turn 1)`),
      `turn 1 stderr missing '(context: …, turn 1)' annotation: ${r1.stderr}`
    );
    const ctxId = o1.contextId!;
    ok(`turn 1 → ${ctxId}, turnNumber=1, token round-tripped, stderr annotated`);

    // 4. Test --context= continuation.
    console.log('[probe] sending turn 2 (--context=<id>)…');
    const r2 = await runCli([
      'send',
      AGENT,
      `Reply with exactly the single token: CTX_TWO_${epoch}`,
      `--context=${ctxId}`,
      '--timeout=120000',
    ]);
    if (r2.exitCode !== 0) {
      fail(
        'turn 2 send',
        new Error(`exit=${r2.exitCode}\nstdout=${r2.stdout}\nstderr=${r2.stderr}`)
      );
    }
    const o2 = parseSendStdout(r2.stdout);
    assert(o2.status === 'completed', `turn 2 status='${o2.status}'`);
    assert(o2.contextId === ctxId, `turn 2 contextId='${o2.contextId}'`);
    assert(o2.turnNumber === 2, `turn 2 turnNumber=${o2.turnNumber}`);
    assert(
      o2.result.includes(`CTX_TWO_${epoch}`),
      `turn 2 result missing token: ${o2.result.slice(0, 200)}`
    );
    ok(`turn 2 → ${ctxId} stable, turnNumber=2`);

    // 5. CLI-layer mutual exclusion of --new-context and --context.
    console.log('[probe] testing CLI mutual-exclusion…');
    const rExc = await runCli(
      [
        'send',
        AGENT,
        'placeholder prompt',
        '--new-context',
        `--context=${ctxId}`,
      ],
      30_000
    );
    assert(
      rExc.exitCode === 2,
      `mutual-exclusion exit=${rExc.exitCode} (expected 2)`
    );
    assert(
      /mutually exclusive/i.test(rExc.stderr),
      `mutual-exclusion stderr missing helpful message: ${rExc.stderr}`
    );
    ok('mutual exclusion of --new-context + --context exits 2');

    // 6. Bad --context format.
    console.log('[probe] testing malformed --context…');
    const rBad = await runCli(
      ['send', AGENT, 'placeholder prompt', '--context=foo'],
      30_000
    );
    assert(
      rBad.exitCode === 2,
      `malformed --context exit=${rBad.exitCode} (expected 2)`
    );
    assert(
      /invalid --context/i.test(rBad.stderr),
      `malformed --context stderr missing helpful message: ${rBad.stderr}`
    );
    ok('malformed --context=foo exits 2 with helpful stderr');

    // 7. crewmate context list (table).
    console.log('[probe] testing context list (table)…');
    const rList = await runCli(['context', 'list']);
    assert(
      rList.exitCode === 0,
      `context list exit=${rList.exitCode}\nstderr=${rList.stderr}`
    );
    assert(
      rList.stdout.includes(ctxId),
      `context list stdout missing ${ctxId}: ${rList.stdout}`
    );
    assert(
      /probe-test/.test(rList.stdout),
      `context list missing ownerHint=probe-test: ${rList.stdout}`
    );
    // turnCount should be 2.
    const headerLine = rList.stdout
      .split(/\r?\n/)
      .find((l) => l.includes(ctxId));
    assert(headerLine, 'no row for our ctxId');
    assert(
      / 2 /.test(headerLine!),
      `expected turnCount '2' in row: ${headerLine}`
    );
    ok('context list table includes ctxId, turns=2, ownerHint=probe-test');

    // 8. crewmate context list --json.
    console.log('[probe] testing context list --json…');
    const rListJson = await runCli(['context', 'list', '--json']);
    assert(
      rListJson.exitCode === 0,
      `context list --json exit=${rListJson.exitCode}`
    );
    const summaries = JSON.parse(rListJson.stdout) as Array<{
      contextId: string;
      turnCount: number;
      ownerHint: string | null;
    }>;
    const me = summaries.find((s) => s.contextId === ctxId);
    assert(me, `context list --json missing ${ctxId}`);
    assert(
      me!.turnCount === 2,
      `context list --json turnCount=${me!.turnCount}`
    );
    assert(
      me!.ownerHint === 'probe-test',
      `context list --json ownerHint=${me!.ownerHint}`
    );
    ok('context list --json contains the test context');

    // 9. crewmate context show <id> — full transcript.
    console.log('[probe] testing context show…');
    const rShow = await runCli(['context', 'show', ctxId]);
    assert(
      rShow.exitCode === 0,
      `context show exit=${rShow.exitCode}\nstderr=${rShow.stderr}`
    );
    assert(
      rShow.stdout.includes('--- Turn 1 ---') &&
        rShow.stdout.includes('--- Turn 2 ---'),
      `context show missing both turn dividers`
    );
    assert(
      rShow.stdout.includes(`CTX_ONE_${epoch}`),
      'context show missing turn 1 prompt token'
    );
    assert(
      rShow.stdout.includes(`CTX_TWO_${epoch}`),
      'context show missing turn 2 prompt token'
    );
    assert(
      rShow.stdout.includes('--- Reconstructed prompt for next turn ---'),
      'context show missing reconstructed prompt block'
    );
    assert(
      rShow.stdout.includes('This is turn 3 of a continuing conversation'),
      'reconstructed prompt should advertise turn 3 (next turn)'
    );
    ok('context show prints both turns + reconstructed next-turn prompt');

    // 10. context show --tail=1 → only turn 2.
    console.log('[probe] testing context show --tail=1…');
    const rTail = await runCli(['context', 'show', ctxId, '--tail=1']);
    assert(rTail.exitCode === 0, `context show --tail=1 exit=${rTail.exitCode}`);
    assert(
      !rTail.stdout.includes('--- Turn 1 ---'),
      'context show --tail=1 should NOT include turn 1 divider'
    );
    assert(
      rTail.stdout.includes('--- Turn 2 ---'),
      'context show --tail=1 missing turn 2 divider'
    );
    ok('context show --tail=1 shows only turn 2');

    // 11. context show <nonexistent> → exit 2.
    console.log('[probe] testing context show <nonexistent>…');
    const rMissing = await runCli([
      'context',
      'show',
      'ctx_nonexis1', // valid shape (8 base32-ish chars), never minted
    ]);
    assert(
      rMissing.exitCode === 2,
      `context show nonexistent exit=${rMissing.exitCode} (expected 2)`
    );
    assert(
      /context not found/i.test(rMissing.stderr),
      `context show nonexistent stderr: ${rMissing.stderr}`
    );
    ok('context show <nonexistent> exits 2');

    // 12. context destroy → archives.
    console.log('[probe] testing context destroy…');
    const rDestroy = await runCli(['context', 'destroy', ctxId]);
    assert(
      rDestroy.exitCode === 0,
      `context destroy exit=${rDestroy.exitCode}\nstderr=${rDestroy.stderr}`
    );
    assert(
      /archived/i.test(rDestroy.stderr),
      `context destroy stderr missing 'archived': ${rDestroy.stderr}`
    );
    // Confirm it's no longer active.
    const activeDir = path.join(HOME, AGENT, 'contexts', ctxId);
    let stillActive = true;
    try {
      await fs.access(activeDir);
    } catch {
      stillActive = false;
    }
    assert(!stillActive, `context still active after destroy: ${activeDir}`);
    // Confirm it's in .archived/.
    const archivedDir = path.join(HOME, AGENT, 'contexts', '.archived', ctxId);
    await fs.access(archivedDir); // throws if missing
    ok('context destroy moves it from contexts/ to contexts/.archived/');

    // 13. context purge --older-than=0s → drops archive.
    console.log('[probe] testing context purge --older-than=0s…');
    const rPurge = await runCli([
      'context',
      'purge',
      '--older-than=0s',
    ]);
    assert(
      rPurge.exitCode === 0,
      `context purge exit=${rPurge.exitCode}\nstderr=${rPurge.stderr}`
    );
    assert(
      /purged 1/i.test(rPurge.stderr) || /purged \d+/i.test(rPurge.stderr),
      `context purge stderr missing 'purged': ${rPurge.stderr}`
    );
    let stillArchived = true;
    try {
      await fs.access(archivedDir);
    } catch {
      stillArchived = false;
    }
    assert(
      !stillArchived,
      `archive dir still present after purge: ${archivedDir}`
    );
    ok('context purge --older-than=0s removes the archived dir');

    // 14. After purge, list should be empty.
    console.log('[probe] confirming context list now empty…');
    const rListEmpty = await runCli(['context', 'list']);
    assert(
      rListEmpty.exitCode === 0,
      `final context list exit=${rListEmpty.exitCode}`
    );
    assert(
      /no active contexts/i.test(rListEmpty.stderr) ||
        !rListEmpty.stdout.includes(ctxId),
      `final context list still shows ${ctxId}: ${rListEmpty.stdout}`
    );
    ok('context list reports empty after purge');

    console.log('\n[probe] all checks passed');
  } catch (err) {
    await cleanup();
    fail('probe', err);
  }
  await cleanup();
}

main().then(
  () => process.exit(0),
  (err) => fail('main', err)
);
