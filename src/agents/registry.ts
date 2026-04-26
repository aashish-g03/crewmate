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

export const BUILT_IN_AGENTS: Record<string, AgentCard> = {
  // v1 ships read-only / non-interactive flags hardcoded. Workers can't answer
  // interactive approval prompts (their stdin is the mailbox), so plan-mode
  // must be enforced at launch. Bounded per-pool/per-task overrides land in
  // v1.1 — until then there is no supported override path. Editing
  // agent-card.json on disk does NOT survive the next `crewmate init`.
  'gemini-worker': {
    name: 'gemini-worker',
    description:
      'Long-context auditor and hallucination checker via Gemini CLI',
    model: 'gemini',
    contextWindow: 2_000_000,
    strengths: [
      'large-codebase audit',
      'cross-file verification',
      'hallucination check',
    ],
    cliCommand: ['gemini', '-p', '{prompt}', '--approval-mode', 'plan'],
  },
  'kimi-worker': {
    name: 'kimi-worker',
    description: 'Deep-reasoning second opinion via Kimi CLI',
    model: 'kimi',
    contextWindow: 256_000,
    strengths: ['deep reasoning', 'algorithmic problems', 'second opinion'],
    // --plan = kimi's read-only mode. --quiet implies --print --final-message-only.
    cliCommand: ['kimi', '-p', '{prompt}', '--quiet', '--plan'],
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
    // codex exec is non-interactive. --skip-git-repo-check avoids the
    // "not a git repo" prompt for tasks executed outside a repo.
    cliCommand: ['codex', 'exec', '--skip-git-repo-check', '{prompt}'],
    setupHint:
      'Codex CLI not installed. Install via `npm i -g @openai/codex` (or your preferred Codex CLI).',
  },
};

export const DEFAULT_AGENT_CONFIG = {
  poolSize: 3,
  timeoutMs: 300_000,
} as const;
