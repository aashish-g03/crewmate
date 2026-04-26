import { z } from 'zod';

/**
 * Wire-level envelope schemas.
 *
 * Result shape mirrors Claude Code's <task-notification>:
 *   { taskId, status, summary, result, usage }.
 * We use JSON instead of XML — same fields.
 *
 * Schema versioning:
 *   v1 envelopes have no `version` field (or version=1). They never carry
 *   contextId / newContext / ownerHint. v1.0 senders + v1.1 workers must
 *   keep working unchanged: a missing contextId means "fresh context per
 *   send," exactly v1.0 behavior. v1.1 envelopes set version=2 and may
 *   carry the v1.1-only fields below.
 *
 *   The `version` field is documentary; runtime branching uses presence
 *   of contextId / newContext, not the version number. Don't gate logic
 *   on version unless you need to reject something.
 */

const ContextIdSchema = z
  .string()
  .regex(/^ctx_[a-z0-9]{8}$/, 'contextId must look like "ctx_<8 base32 chars>"');

export const TaskRequest = z
  .object({
    // v1 fields (unchanged)
    taskId: z.string().uuid(),
    agent: z.string(),
    prompt: z.string(),
    context: z
      .object({
        cwd: z.string().optional(),
        files: z.array(z.string()).optional(),
      })
      .optional(),
    timeoutMs: z.number().int().positive().default(300_000),
    metadata: z.record(z.unknown()).optional(),
    createdAt: z.string().datetime(),

    // v1.1 additions — all optional; v1 envelopes pass through as v1 behavior.
    version: z.number().int().positive().default(1),
    /** Continue an existing conversation. Mutually exclusive with `newContext`. */
    contextId: ContextIdSchema.optional(),
    /** Mint a fresh context for this task; result will return the new contextId. */
    newContext: z.boolean().default(false),
    /** Free-form label stored in meta.json — for `context list` filtering. */
    ownerHint: z.string().max(64).optional(),
    /** TTL override (ms) for newly-minted contexts. Only honored when newContext=true. */
    ttlMs: z.number().int().positive().optional(),
  })
  .refine(
    (v) => !(v.newContext && v.contextId),
    {
      message:
        'newContext and contextId are mutually exclusive — pass one or neither, not both.',
      path: ['newContext'],
    }
  );

export const TaskResult = z.object({
  // v1 fields (unchanged)
  taskId: z.string().uuid(),
  agent: z.string(),
  status: z.enum(['completed', 'failed', 'timeout', 'canceled']),
  summary: z.string(),
  result: z.string(),
  error: z.string().nullable(),
  usage: z.object({
    durationMs: z.number(),
    exitCode: z.number().nullable(),
    stdoutBytes: z.number(),
  }),
  completedAt: z.string().datetime(),

  // v1.1 additions — null when the task ran fresh-context, set otherwise.
  /** The context this turn used, or null if the task ran without a context. */
  contextId: ContextIdSchema.nullable().optional(),
  /** 1-indexed turn number within the context. Absent if contextId is null. */
  turnNumber: z.number().int().positive().optional(),
});

export const AgentCard = z
  .object({
    name: z.string(),
    description: z.string(),
    model: z.string(),
    contextWindow: z.number().int().positive(),
    strengths: z.array(z.string()),
    cliCommand: z.array(z.string()),
    // Optional hint shown by `doctor`/`list` for binary-present-but-needs-config
    // cases that `which` can't detect (e.g. kimi installed but model not chosen).
    setupHint: z.string().optional(),
  })
  // Pre-existing on-disk cards may carry a `headlessFlag` field that's been
  // dropped from the schema. Pass-through so loadAgentCard() doesn't reject
  // them; init will rewrite without it.
  .passthrough();

export const AgentConfig = z.object({
  poolSize: z.number().int().positive().default(3),
  timeoutMs: z.number().int().positive().default(300_000),
});

export type TaskRequest = z.infer<typeof TaskRequest>;
/**
 * Input shape for callers — defaulted fields (version, newContext) are
 * optional. Use this for `writeTaskRequest` parameters so v1.0 callers
 * keep compiling without setting v1.1-only fields explicitly.
 */
export type TaskRequestInput = z.input<typeof TaskRequest>;
export type TaskResult = z.infer<typeof TaskResult>;
export type AgentCard = z.infer<typeof AgentCard>;
export type AgentConfig = z.infer<typeof AgentConfig>;
export type TaskStatus = TaskResult['status'];

// ─── v1.1 context storage schemas ────────────────────────────────────────────
//
// On-disk shapes for ~/.crewmate/<agent>/contexts/<id>/{meta,turn_NNN}.json.
// Validated on every read so a hand-edited or partially-written file fails
// loudly rather than producing garbage downstream.

export const ContextTurn = z.object({
  taskId: z.string().uuid(),
  prompt: z.string(),
  response: z.string(),
  usage: z.object({
    durationMs: z.number(),
    exitCode: z.number().nullable(),
    stdoutBytes: z.number(),
  }),
  timestamp: z.string().datetime(),
});

export const ContextMeta = z.object({
  contextId: z.string(),
  agent: z.string(),
  created: z.string().datetime(),
  lastUsed: z.string().datetime(),
  ownerHint: z.string().max(64).optional(),
  turnCount: z.number().int().min(0),
  // 30 minutes of idle = TTL by default. Storage layer never enforces; the
  // lifecycle sweeper (Step 5) reads this and decides when to archive.
  ttlMs: z.number().int().positive().default(30 * 60 * 1000),
});

export type ContextTurn = z.infer<typeof ContextTurn>;
export type ContextMeta = z.infer<typeof ContextMeta>;
