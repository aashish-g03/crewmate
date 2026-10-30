/**
 * Build the argv the ACP shim spawns for one prompt.
 *
 * Tokens in the shim's args:
 * - `{prompt}` is replaced by the full prompt (as a whole token or inside one).
 * - `?model:<tok>` is kept only when a model was set for the session, with
 *   `{model}` inside it substituted. Lets an agent card say how its CLI takes a
 *   model, e.g. `'?model:-m', '?model:{model}'` for `codex exec -m <id>`.
 * - `?effort:<tok>` is the same for a reasoning effort, e.g.
 *   `'?effort:-c', '?effort:model_reasoning_effort="{effort}"'`.
 *
 * Without a model or effort the optional tokens vanish, so cards that never
 * use them, and sessions that never set them, spawn exactly what they did before.
 */
export interface ShimArgvOptions {
  prompt: string;
  model?: string;
  effort?: string;
}

export function buildShimArgv(binary: string, args: string[], opts: ShimArgvOptions): string[] {
  const out: string[] = [binary];
  for (const raw of args) {
    let tok = raw;
    if (tok.startsWith('?model:')) {
      if (!opts.model) continue;
      tok = tok.slice('?model:'.length).replaceAll('{model}', opts.model);
    } else if (tok.startsWith('?effort:')) {
      if (!opts.effort) continue;
      tok = tok.slice('?effort:'.length).replaceAll('{effort}', opts.effort);
    }
    out.push(tok === '{prompt}' ? opts.prompt : tok.replaceAll('{prompt}', opts.prompt));
  }
  return out;
}
