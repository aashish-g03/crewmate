// Helper process for the lock race test: try to take the writer lock once, print ok/refused.
import { resolveWorkspace } from '../plugins/crewmate/lib/workspace.mjs';
import { acquireWriter } from '../plugins/crewmate/lib/lock.mjs';
const [, , cwd, me] = process.argv;
const ws = resolveWorkspace(cwd, process.env);
const r = acquireWriter(ws, me, process.env);
process.stdout.write(r.ok ? 'ok' : 'refused');
