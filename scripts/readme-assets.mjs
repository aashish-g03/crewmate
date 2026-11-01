#!/usr/bin/env node
// Builds assets/readme/demo.svg from real recordings (assets/readme/recordings/*.json, made by
// recording crewmate's stdout with timestamps). Lines are the real output, in order; long waits
// are compressed so the loop stays short. Usage: node scripts/readme-assets.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REC = path.join(ROOT, 'assets/readme/recordings');
// Presets: `readme` (900 px, 13 px text, both scenes) and dev.to-sized single scenes
// (800 px canvas, 17 px text, about 62 columns; see the publishing-to-devto visuals guide).
const PRESETS = {
  readme: { out: 'assets/readme/demo.svg', width: 900, font: 13, cols: 96, scenes: ['ask', 'critique'] },
  'launch-ask': { out: 'assets/launch/ask.svg', width: 800, font: 17, cols: 62, scenes: ['ask'] },
  'launch-critique': { out: 'assets/launch/critique-brief.svg', width: 800, font: 17, cols: 62, scenes: ['critique-brief'] },
};
const presetName = process.argv[process.argv.indexOf('--preset') + 1] && process.argv.includes('--preset') ? process.argv[process.argv.indexOf('--preset') + 1] : 'readme';
const PRESET = PRESETS[presetName];
if (!PRESET) throw new Error(`unknown preset ${presetName}`);
const OUT = path.join(ROOT, PRESET.out);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const MAX_COLS = PRESET.cols;
const clean = (s) =>
  s
    .replace(/\/Users\/[^ "')]*\/(repo|demo)\//g, '')
    .replace(/file:\/\/\/[^ )]*\/repo\//g, '')
    .replace(/\s+/g, ' ')
    .trim();
const clip = (s) => (s.length > MAX_COLS ? `${s.slice(0, MAX_COLS - 1)}…` : s);

/** @returns {{t: number, text: string}[]} real lines, blanks dropped, paths shortened */
function load(name) {
  const j = JSON.parse(fs.readFileSync(path.join(REC, name), 'utf8'));
  return j.lines.map((l) => ({ t: l.t, text: clip(clean(l.text)) })).filter((l) => l.text);
}

// Scene 1: ask codex (foreground). Scene 2: critique --diff, watched.
const SCENES = {
  ask: () => ({ cmd: '/crewmate:ask codex Is sumTo in calc.js correct? Answer in two sentences.', lines: load('ask-codex.json') }),
  critique: () => ({ cmd: '/crewmate:critique --diff        # Codex and Gemini review the change, in parallel', lines: load('critique-watch.json').filter((l) => !/^\[|^###|^The change adds/.test(l.text)) }),
  'critique-brief': () => ({ cmd: '/crewmate:critique --diff   # watched with --brief', lines: load('critique-brief.json') }),
};
const scenes = PRESET.scenes.map((k) => SCENES[k]());
if (presetName !== 'readme') for (const sc of scenes) sc.cmd = clip(sc.cmd);

// Compress time: a gap between lines becomes min(gap, 900 ms), at least 120 ms.
const rows = [];
let clock = 600;
for (const sc of scenes) {
  rows.push({ at: clock, text: `> ${sc.cmd}`, kind: 'cmd' });
  clock += 900;
  let prev = sc.lines[0]?.t ?? 0;
  for (const l of sc.lines) {
    clock += Math.max(120, Math.min(900, l.t - prev));
    prev = l.t;
    rows.push({ at: clock, text: l.text, kind: 'out' });
  }
  clock += 1800;
  rows.push({ at: clock, text: '', kind: 'gap' });
}
const cycle = clock + 2500;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function colorize(text, kind) {
  if (kind === 'cmd') return `<tspan class="p">${esc(text.slice(0, 2))}</tspan><tspan class="c">${esc(text.slice(2))}</tspan>`;
  const m = /^((?:codex|gemini)(?::\w+)?) (#\d+) (.)(.*)$/.exec(text);
  if (!m) return `<tspan class="d">${esc(text)}</tspan>`;
  const [, who, n, glyph, rest] = m;
  const v = who.startsWith('codex') ? 'cx' : 'gm';
  const g = { '●': 'ok', '▶': 'run', '✓': 'ok', '✗': 'err', '■': 'end', '…': 'note' }[glyph] ?? 'd';
  return `<tspan class="${v}">${esc(who)}</tspan> <tspan class="d">${n}</tspan> <tspan class="${g}">${esc(glyph)}${esc(rest)}</tspan>`;
}

const LINE_H = Math.round(PRESET.font * 1.5);
const VISIBLE = Math.max(...scenes.map((sc) => sc.lines.length + 1));
const W = PRESET.width;
const TOP = 36 + LINE_H + 10;
const H = TOP + VISIBLE * LINE_H + 18;
// Each screen shows a scene; rows scroll by restarting per scene.
let y0 = 0;
const parts = [];
let sceneStart = 0;
let lineInScene = 0;
for (const r of rows) {
  if (r.kind === 'cmd') {
    lineInScene = 0;
    sceneStart = r.at;
  }
  if (r.kind === 'gap') continue;
  const y = TOP + lineInScene * LINE_H;
  lineInScene++;
  if (lineInScene > VISIBLE) continue;
  const showAt = (r.at / cycle) * 100;
  // hide when the next scene starts (or at the end of the cycle)
  const next = rows.find((x) => x.kind === 'cmd' && x.at > sceneStart);
  const hideAt = ((next ? next.at - 1 : cycle - 400) / cycle) * 100;
  const id = `l${parts.length}`;
  parts.push({ id, y, html: colorize(r.text, r.kind), showAt, hideAt });
}

const keyframes = parts
  .map((p) => `@keyframes ${p.id}{0%,${p.showAt.toFixed(2)}%{opacity:0}${(p.showAt + 0.01).toFixed(2)}%,${p.hideAt.toFixed(2)}%{opacity:1}${(p.hideAt + 0.01).toFixed(2)}%,100%{opacity:0}}#${p.id}{animation:${p.id} ${(cycle / 1000).toFixed(1)}s linear infinite}`)
  .join('\n');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="crewmate running a real Codex job and a Codex + Gemini critique, with live progress">
<style>
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:${PRESET.font}px;white-space:pre}
.p{fill:#7ee0d0}.c{fill:#e6edf3;font-weight:600}.d{fill:#8b949e}
.cx{fill:#3fd0a0;font-weight:700}.gm{fill:#7aa7ff;font-weight:700}
.ok{fill:#3fd0a0}.run{fill:#c9d1d9}.err{fill:#ff7b72}.end{fill:#e6edf3;font-weight:700}.note{fill:#d2a8ff}
${keyframes}
</style>
<rect width="${W}" height="${H}" rx="12" fill="#0d1117"/>
<rect width="${W}" height="36" rx="12" fill="#161b22"/><rect y="24" width="${W}" height="12" fill="#161b22"/>
<circle cx="22" cy="18" r="6" fill="#ff5f57"/><circle cx="42" cy="18" r="6" fill="#febc2e"/><circle cx="62" cy="18" r="6" fill="#28c840"/>
<text x="${W / 2}" y="23" text-anchor="middle" class="d" style="font-size:${Math.min(13, PRESET.font)}px">claude code · crewmate (real output, waits shortened)</text>
${parts.map((p) => `<text id="${p.id}" x="20" y="${p.y}" opacity="0">${p.html}</text>`).join('\n')}
</svg>
`;
fs.writeFileSync(OUT, svg);
console.log(`wrote ${path.relative(ROOT, OUT)}: ${parts.length} lines, ${(cycle / 1000).toFixed(1)} s loop, ${(svg.length / 1024).toFixed(1)} KB`);
