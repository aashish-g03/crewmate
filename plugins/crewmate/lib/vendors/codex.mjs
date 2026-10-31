// Codex adapter: `codex exec --json` (one process per job, NDJSON on stdout).
import { parseJson, cut } from './index.mjs';

/** @param {any} job */
function permArgs(job) {
  if (job.flags?.yolo) return ['--dangerously-bypass-approvals-and-sandbox'];
  // Always `-c sandbox_mode=…`: `codex exec resume` has no `-s` option.
  return ['-c', `sandbox_mode="${job.flags?.write ? 'workspace-write' : 'read-only'}"`];
}

/** @type {import('./index.mjs').Adapter} */
export const codexAdapter = {
  binary: 'codex',

  buildArgs(job, prompt, resultFile) {
    const f = job.flags ?? {};
    const common = ['--json', '--skip-git-repo-check', '-o', resultFile, ...permArgs(job)];
    if (f.model) common.push('-m', f.model);
    if (f.effort) common.push('-c', `model_reasoning_effort="${f.effort}"`);
    if (f.resumeConversationId) return ['exec', 'resume', ...common, f.resumeConversationId, '--', prompt];
    return ['exec', ...common, '--', prompt];
  },

  createParser() {
    /** @type {import('./index.mjs').ParsedOutcome} */
    const out = { conversationId: null, answer: null, deniedTools: [], toolErrors: [], usage: null, vendorError: null, permissionMode: null };
    return {
      feed(line) {
        const o = parseJson(line);
        if (!o) return [{ type: 'note', text: line }];
        if ('fixture_note' in o) return [];
        const item = o.item ?? {};
        switch (o.type) {
          case 'thread.started':
            out.conversationId = o.thread_id ?? null;
            return [];
          case 'turn.started':
            return [];
          case 'item.started':
          case 'item.completed':
            if (item.type === 'command_execution') {
              const target = cut(item.command);
              if (o.type === 'item.started') return [{ type: 'tool', name: 'shell', target, phase: 'start' }];
              const ok = item.exit_code === 0;
              if (!ok) out.toolErrors.push(String(item.command ?? ''));
              return [{ type: 'tool', name: 'shell', target, phase: ok ? 'done' : 'error' }];
            }
            if (item.type === 'agent_message') {
              return o.type === 'item.completed' && String(item.text ?? '').trim() ? [{ type: 'note', text: String(item.text) }] : [];
            }
            return [];
          case 'turn.completed': {
            const u = o.usage ?? {};
            out.usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 };
            return [{ type: 'usage', ...out.usage }];
          }
          case 'turn.failed':
          case 'error':
            out.vendorError = String(o.error?.message ?? o.message ?? o.type);
            return [];
          default:
            return [{ type: 'note', text: line }];
        }
      },
      isModelEvent(line) {
        const o = parseJson(line);
        if (!o || typeof o.type !== 'string') return false;
        return o.type.startsWith('item.') || o.type === 'turn.completed' || o.type === 'turn.failed';
      },
      finish() {
        return out;
      },
    };
  },

  expectedPermissionMode() {
    return null;
  },
};
