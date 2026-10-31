// Gemini adapter: Antigravity CLI `agy -p … --output-format stream-json`.
import { parseJson, cut } from './index.mjs';

/** @param {any} params */
function firstString(params) {
  for (const v of Object.values(params ?? {})) if (typeof v === 'string') return v;
  return '';
}

/** @type {import('./index.mjs').Adapter} */
export const geminiAdapter = {
  binary: 'agy',

  buildArgs(job, prompt) {
    const f = job.flags ?? {};
    const secs = Math.ceil((f.timeoutMs ?? 600_000) / 1000) + 30; // past crewmate's own deadline
    const args = ['-p', prompt, '--output-format', 'stream-json', '--print-timeout', `${secs}s`];
    // Read-only: no --mode. Headless agy runs in `request-review` and denies anything that needs
    // approval (the runner checks init.permission_mode). `--mode plan` turned questions into plans.
    if (f.yolo) args.push('--dangerously-skip-permissions');
    else if (f.write) args.push('--mode', 'accept-edits');
    if (f.model) args.push('--model', f.model);
    if (f.effort) args.push('--effort', f.effort);
    if (f.resumeConversationId) args.push('--conversation', f.resumeConversationId);
    return args;
  },

  createParser() {
    /** @type {import('./index.mjs').ParsedOutcome} */
    const out = { conversationId: null, answer: null, deniedTools: [], toolErrors: [], usage: null, vendorError: null, permissionMode: null };
    const started = new Set();
    /** @type {Map<number, string>} */
    const text = new Map();
    return {
      feed(line) {
        const o = parseJson(line);
        if (!o) return [{ type: 'note', text: line }];
        if ('fixture_note' in o) return [];
        if (o.event === 'init') {
          out.conversationId = o.conversation_id ?? null;
          out.permissionMode = o.init?.permission_mode ?? null;
          return [];
        }
        if (o.event === 'step_update') {
          const s = o.step_update ?? {};
          if (s.step_type === 'user_input') return [];
          if (s.step_type === 'tool') {
            const name = String(s.tool_name ?? s.tool_info?.name ?? 'tool');
            const target = cut(firstString(s.tool_info?.parameters));
            if (s.state === 'ACTIVE') {
              if (started.has(s.step_index)) return [];
              started.add(s.step_index);
              return [{ type: 'tool', name, target, phase: 'start' }];
            }
            if (s.state === 'DONE') return [{ type: 'tool', name, target, phase: 'done' }];
            if (s.state === 'ERROR') {
              out.toolErrors.push(name);
              return [{ type: 'tool', name, target, phase: 'error' }];
            }
            return [];
          }
          if (s.step_type === 'agent_response') {
            if (typeof s.text_delta === 'string') text.set(s.step_index, (text.get(s.step_index) ?? '') + s.text_delta);
            if (s.state === 'DONE') {
              const t = (text.get(s.step_index) ?? '').trim();
              text.delete(s.step_index);
              return t ? [{ type: 'note', text: t }] : [];
            }
            return [];
          }
          return [];
        }
        if (o.event === 'result') {
          const r = o.result ?? {};
          out.answer = typeof r.response === 'string' ? r.response : '';
          out.deniedTools = (r.denied_actions ?? []).map((d) => String(d.display_name ?? d.action ?? 'unknown'));
          if (r.status !== 'SUCCESS') out.vendorError = `agy status ${r.status ?? 'unknown'}`;
          if (r.usage) {
            out.usage = { input: r.usage.input_tokens ?? 0, output: r.usage.output_tokens ?? 0 };
            return [{ type: 'usage', ...out.usage }];
          }
          return [];
        }
        return [{ type: 'note', text: line }];
      },
      isModelEvent(line) {
        const o = parseJson(line);
        if (!o) return false;
        if (o.event === 'result') return true;
        return o.event === 'step_update' && o.step_update?.step_type !== 'user_input';
      },
      finish() {
        return out;
      },
    };
  },

  expectedPermissionMode(job) {
    return job.flags?.yolo ? null : 'request-review';
  },
};
