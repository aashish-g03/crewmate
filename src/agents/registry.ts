import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentCard } from '../envelope.ts';

/**
 * Built-in agent definitions.
 *
 * `crewmate init` materializes one directory per entry, dropping a copy of
 * the card as agent-card.json plus a default config.json.
 *
 * Adding a new agent is just a matter of appending to this map — the rest
 * of the runtime is fully data-driven from agent-card.json on disk.
 */

const SHIM_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'transports',
  'acp-shim.ts'
);

export const BUILT_IN_AGENTS: Record<string, AgentCard> = {
  // Workers can't answer interactive approval prompts (stdin is the mailbox).
  // `auto_edit` auto-approves file reads + edits; shell commands still require
  // approval (= hang in headless mode = safe fail). `plan` mode was too
  // restrictive — it blocked ALL tool use including file reads, making gemini
  // useless for the codebase-audit use case it exists for.
  // `--skip-trust` bypasses Gemini's workspace trust gate — headless workers
  // can't answer interactive trust prompts, and the user already trusts the
  // workspace by supplying --cwd to `crewmate send`.
  'gemini-worker': {
    name: 'gemini-worker',
    description:
      'Long-context auditor and hallucination checker via Antigravity CLI (agy)',
    model: 'gemini',
    contextWindow: 1_000_000,
    strengths: [
      'large-codebase audit',
      'cross-file verification',
      'hallucination check',
    ],
    cliCommand: ['agy', '-p', '{prompt}', '--sandbox'],
    transport: 'acp',
    // Antigravity CLI (agy): Gemini CLI stopped serving individual Google accounts on
    // 2026-06-18. agy has no ACP mode yet, so it runs through the shim in headless
    // print mode; --sandbox restricts its terminal and print mode's request-review
    // permissions never auto-approve writes.
    acpCommand: [
      'bun', SHIM_PATH, 'agy', '-p', '{prompt}',
      '?model:--model', '?model:{model}',
      '?effort:--effort', '?effort:{effort}',
      '--sandbox',
    ],
    setupHint:
      'Antigravity CLI not ready. Install: `curl -fsSL https://antigravity.google/cli/install.sh | bash`, then run `agy` once interactively to sign in.',
  },
  'kimi-worker': {
    name: 'kimi-worker',
    description: 'Deep-reasoning second opinion via Kimi CLI',
    model: 'kimi',
    contextWindow: 256_000,
    strengths: ['deep reasoning', 'algorithmic problems', 'second opinion'],
    cliCommand: ['kimi', '-p', '{prompt}', '--quiet', '--plan'],
    transport: 'acp',
    acpCommand: ['bun', SHIM_PATH, 'kimi', '-p', '{prompt}', '--quiet', '--plan'],
    setupHint:
      "If you see 'LLM not set' on first run: run `kimi` once interactively, pick a model, set the API key.",
  },
  'codex-worker': {
    name: 'codex-worker',
    description: 'Vendor-diversity worker (OpenAI family) via Codex CLI',
    model: 'codex',
    contextWindow: 200_000,
    strengths: [
      'vendor diversity',
      'OpenAI-family refactors',
      'cross-vendor reconciliation',
    ],
    cliCommand: ['codex', 'exec', '--skip-git-repo-check', '{prompt}'],
    transport: 'acp',
    acpCommand: [
      'bun', SHIM_PATH, 'codex', 'exec', '--skip-git-repo-check',
      '?model:-m', '?model:{model}',
      '?effort:-c', '?effort:model_reasoning_effort="{effort}"',
      '{prompt}',
    ],
    setupHint:
      'Codex CLI not installed. Install via `npm i -g @openai/codex` (or your preferred Codex CLI).',
  },
};

export const DEFAULT_AGENT_CONFIG = {
  poolSize: 1,
  maxWorkers: 5,
  timeoutMs: 300_000,
  maxRetries: 2,
} as const;
