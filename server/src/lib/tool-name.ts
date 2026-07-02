/**
 * MCP clients (Claude.ai, ChatGPT) require tool names to match
 * ^[a-zA-Z0-9_-]{1,64}$ — anything else is rejected at tools/list.
 */
export const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Map an arbitrary stored tool name onto the MCP-safe charset. */
export function mcpToolName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return safe || 'tool';
}
