// Gemini adapter: Antigravity CLI `agy -p … --output-format stream-json`.
import fs from 'node:fs';
import path from 'node:path';
import { parseJson, cut } from './index.mjs';

const READ_ONLY_RULE = /^(read_file|list_dir|grep_search|find_by_name|view_file|read_url_content|search_web)(\(.*\))?$/;

export const READ_ONLY_NOTE =
  'Note from crewmate: this run is read-only. Read files with your file tools (read_file, list_dir, grep_search); shell commands and file edits are not available and will be denied.';

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
    // Without this note agy tries shell commands, is denied in headless mode, and often gives up
    // with an empty answer (recorded 2026-11-01).
    if (!f.write && !f.yolo) prompt = `${prompt}\n\n${READ_ONLY_NOTE}`;
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
    const out = { conversationId: null, answer: null, deniedTools: [], toolErrors: [], usage: null, vendorError: null, permissionMode: null, timedOut: false };
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
          if (r.finished_reason === 'print_timeout') out.timedOut = true;
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

  /**
   * Fail closed: agy reports `request-review` even when the user's settings allow writes or shell
   * (recorded 2026-11-01: a write_file allow-rule wrote the file). A read-only job must not run then.
   */
  preflight(job, env) {
    if (job.flags?.write || job.flags?.yolo) return null;
    const file = path.join(env.HOME || '', '.gemini', 'antigravity-cli', 'settings.json');
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return null; // no settings file: only the headless default applies
    }
    let allow;
    try {
      allow = JSON.parse(text)?.permissions?.allow ?? [];
    } catch {
      return `cannot read agy settings (${file}); crewmate cannot confirm this run is read-only — fix the file or pass --write`;
    }
    // Known-safe list, not a known-bad list: any rule outside it may let agy write or run commands.
    const risky = (Array.isArray(allow) ? allow : [allow]).filter((r) => !READ_ONLY_RULE.test(String(r)));
    if (!risky.length) return null;
    return `agy settings allow ${risky.join(', ')} (${file}); crewmate cannot keep this read-only run read-only — remove those rules or pass --write`;
  },

  expectedPermissionMode(job) {
    return job.flags?.yolo ? null : 'request-review';
  },
};
