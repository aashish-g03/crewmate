/**
 * Shared internal types not tied to a wire schema.
 */

export interface RunnerResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Filled in if the run was aborted via signal or timed out. */
  hint?: 'aborted' | 'timeout';
}

export interface RunnerOptions {
  cwd?: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Path to write captured stdout to (in addition to returning it as a string). */
  stdoutLogPath?: string;
  /** Path to write captured stderr to (in addition to returning it as a string). */
  stderrLogPath?: string;
}

export interface LogEvent {
  ts: string;
  event: string;
  agent?: string;
  taskId?: string;
  pid?: number;
  /** PID of the dead worker whose task we re-queued (orphan recovery). */
  orphanPid?: number;
  /** Tool name for `mcp_tool_call` events. */
  tool?: string;
  durationMs?: number;
  status?: string;
  error?: string;
  poolSize?: number;
  exitCode?: number | null;
  reason?: string;
  message?: string;
  stdoutBytes?: number;
  // v1.1 context events: context_minted, context_used, context_archived,
  // context_full, affinity_claimed, affinity_released, affinity_recovered.
  contextId?: string;
  turnNumber?: number;
  ownerHint?: string;
  capacity?: number;
  currentCount?: number;
  promptBytes?: number;
}
