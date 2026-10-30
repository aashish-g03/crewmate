import { describe, expect, test } from 'bun:test';
import { buildShimArgv } from './shim-argv';

const CODEX = [
  'exec', '--skip-git-repo-check',
  '?model:-m', '?model:{model}',
  '?effort:-c', '?effort:model_reasoning_effort="{effort}"',
  '{prompt}',
];

describe('buildShimArgv', () => {
  test('drops optional tokens when no model or effort is set', () => {
    expect(buildShimArgv('codex', CODEX, { prompt: 'hi' })).toEqual(['codex', 'exec', '--skip-git-repo-check', 'hi']);
  });

  test('passes the model through', () => {
    expect(buildShimArgv('codex', CODEX, { prompt: 'hi', model: 'gpt-6-sol' }))
      .toEqual(['codex', 'exec', '--skip-git-repo-check', '-m', 'gpt-6-sol', 'hi']);
  });

  test('passes model and effort through', () => {
    expect(buildShimArgv('codex', CODEX, { prompt: 'hi', model: 'gpt-6-sol', effort: 'high' }))
      .toEqual(['codex', 'exec', '--skip-git-repo-check', '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort="high"', 'hi']);
  });

  test('passes effort alone', () => {
    expect(buildShimArgv('codex', CODEX, { prompt: 'hi', effort: 'low' }))
      .toEqual(['codex', 'exec', '--skip-git-repo-check', '-c', 'model_reasoning_effort="low"', 'hi']);
  });

  test('substitutes {prompt} inside a token and leaves cards without optional tokens unchanged', () => {
    expect(buildShimArgv('kimi', ['-p', '{prompt}', '--quiet', 'x={prompt}'], { prompt: 'q', model: 'm' }))
      .toEqual(['kimi', '-p', 'q', '--quiet', 'x=q']);
  });
});
