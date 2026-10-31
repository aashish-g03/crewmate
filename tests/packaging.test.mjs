import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'plugins/crewmate/bin/crewmate');

function hasClaude() {
  return spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;
}

function walk(dir, ext, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

test('marketplace and plugin validate', (t) => {
  if (!hasClaude()) return t.skip('claude CLI not on PATH');
  for (const target of ['.', 'plugins/crewmate']) {
    const r = spawnSync('claude', ['plugin', 'validate', target], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, `${target}: ${r.stdout}${r.stderr}`);
  }
});

test('no runtime dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  const files = walk(path.join(ROOT, 'plugins/crewmate'), '.mjs');
  assert.ok(files.length > 0, 'no .mjs files found');
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/^\s*import\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
      assert.ok(m[1].startsWith('node:') || m[1].startsWith('.'), `${f} imports ${m[1]}`);
    }
  }
});

test('unknown command exits 2', () => {
  const r = spawnSync(process.execPath, [BIN, 'nope'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/i);
});

test('commands and skill always call through ${CLAUDE_PLUGIN_ROOT}, never a bare crewmate', () => {
  const files = [
    ...fs.readdirSync(path.join(ROOT, 'plugins/crewmate/commands')).map((f) => path.join(ROOT, 'plugins/crewmate/commands', f)),
    path.join(ROOT, 'plugins/crewmate/skills/crewmate/SKILL.md'),
  ];
  const names = files.map((f) => path.basename(f)).sort();
  assert.deepEqual(names, ['SKILL.md', 'ask.md', 'cancel.md', 'critique.md', 'result.md', 'setup.md', 'status.md']);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(src.includes('${CLAUDE_PLUGIN_ROOT}/bin/crewmate'), `${f} uses the plugin root`);
    for (const line of src.split('\n')) assert.doesNotMatch(line, /^\s*\$?\s*crewmate\s+(ask|critique|watch|status|result|cancel|setup)\b/, `${f}: bare call: ${line}`);
  }
});

test('the skill carries the testing rule for delegated test work', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'plugins/crewmate/skills/crewmate/SKILL.md'), 'utf8');
  assert.match(skill, /testing-rule\.md/);
});
