/**
 * `crewmate mcp` — launch the MCP server on stdio.
 *
 * The MCP SDK is loaded via dynamic import here so that running plain CLI
 * subcommands (init, send, status, ...) doesn't pay the cost of pulling in
 * `@modelcontextprotocol/sdk` and its transitive deps (express, hono, jose,
 * etc.). Today the bash CLI's `--help` runs in <500ms; this preserves that
 * for non-MCP invocations.
 */
export async function cmdMcp(): Promise<void> {
  const { runMcpServer } = await import('../mcp/server.ts');
  await runMcpServer();
}
