import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appendEvent, readEvents } from '../plugins/crewmate/lib/events.mjs';
import { tempDir } from './helpers.mjs';

test('a trailing half-written line is ignored; a missing file is empty', () => {
  const dir = tempDir();
  appendEvent(dir, { n: 1, type: 'started', vendor: 'codex', model: null });
  fs.appendFileSync(path.join(dir, 'events.ndjson'), '{"n":2,"type":"no');
  assert.deepEqual(readEvents(dir).map((e) => e.n), [1]);
  assert.deepEqual(readEvents(tempDir()), []);
});

test('a 500-char note is stored as 200 chars ending in …', () => {
  const dir = tempDir();
  appendEvent(dir, { n: 1, type: 'note', text: 'x'.repeat(500) });
  const [ev] = readEvents(dir);
  assert.equal(ev.text.length, 200);
  assert.ok(ev.text.endsWith('…'));
});
