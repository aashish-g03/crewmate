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
    const out = { conversationId: null, answer: null, deniedTools: [], toolErrors: [], usage: null, vendorError: null, permissionMode: null, lastError: null };
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
            if (item.type === 'reasoning' || !item.type) return [];
            // file_change, mcp_tool_call, web_search, …: show them as tools.
            {
              const target = cut(item.changes?.map((c) => c.path).join(' ') ?? item.tool ?? item.query ?? '');
              if (o.type === 'item.started') return [{ type: 'tool', name: String(item.type), target, phase: 'start' }];
              const failed = item.status === 'failed';
              if (failed) out.toolErrors.push(String(item.type));
              return [{ type: 'tool', name: String(item.type), target, phase: failed ? 'error' : 'done' }];
            }
          case 'turn.completed': {
            const u = o.usage ?? {};
            out.usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 };
            return [{ type: 'usage', ...out.usage }];
          }
          case 'turn.failed':
            out.vendorError = String(o.error?.message ?? o.message ?? 'turn failed');
            return [];
          case 'error':
            // Often recoverable ("Reconnecting... 1/5"); only turn.failed or a non-zero exit fails the job.
            out.lastError = String(o.message ?? o.error?.message ?? 'error');
            return [{ type: 'note', text: `error: ${out.lastError}` }];
          default:
            return [{ type: 'note', text: line }];
        }
      },
      isModelEvent(line) {
        const o = parseJson(line);
        if (!o || typeof o.type !== 'string') return false;
        // turn.started counts: at high effort the first item can take a minute; a signed-out codex
        // fails fast with an error and a non-zero exit instead of hanging.
        return o.type.startsWith('item.') || o.type.startsWith('turn.');
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
