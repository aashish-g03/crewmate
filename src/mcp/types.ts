import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  ServerRequest,
  ServerNotification,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Shorthand for the `extra` object every MCP tool handler receives. Carries
 * the per-request AbortSignal, the optional progressToken under `_meta`,
 * and `sendNotification` for emitting `notifications/progress` back to the
 * client during long-running tool calls.
 */
export type McpExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Standard MCP `content` block we emit from every tool handler. */
export interface ToolTextContent {
  type: 'text';
  text: string;
}

/**
 * Shape of the value we return from a tool handler. The trailing index
 * signature is required because the SDK's `CallToolResult` is declared as
 * `{ [x: string]: unknown; ... }`, so without it TypeScript rejects our
 * narrower shape at the registerTool() call site.
 */
export interface ToolReturn {
  [k: string]: unknown;
  content: ToolTextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
