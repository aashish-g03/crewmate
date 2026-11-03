// `crewmate models [codex|gemini] [--json]`: models and effort levels each vendor offers.
import { parseArgs } from '../vendored/args.mjs';
import { VENDORS, assertName } from '../names.mjs';
import { vendorModels } from '../models.mjs';

/** @param {string[]} argv @param {any} io */
export async function run(argv, io) {
  const { options, positionals } = parseArgs(argv, { booleanOptions: ['json'] });
  const vendors = positionals.length ? positionals.map((v) => assertName('vendor', v)) : [...VENDORS];
  const all = vendors.map((v) => vendorModels(/** @type {any} */ (v), io.env));
  if (options.json) {
    io.stdout.write(`${JSON.stringify({ vendors: all })}\n`);
    return 0;
  }
  for (const v of all) {
    if (!v.available) {
      io.stdout.write(`${v.vendor}: ${v.error}\n\n`);
      continue;
    }
    const cfg = v.configured?.model ? `  (your default: ${v.configured.model}${v.configured.effort ? `, effort ${v.configured.effort}` : ''})` : '';
    io.stdout.write(`${v.vendor}${cfg}\n`);
    const w = Math.max(...v.models.map((m) => m.id.length));
    for (const m of v.models) {
      const mark = m.id === v.configured?.model ? '*' : ' ';
      const def = m.defaultEffort ? ` default ${m.defaultEffort};` : '';
      io.stdout.write(` ${mark} ${m.id.padEnd(w)}  ${m.name}  —${def} effort: ${m.efforts.join(', ')}\n`);
    }
    io.stdout.write('\n');
  }
  return 0;
}
