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

/** Human-readable MCP `title` from a displayName/name: "get_account_summaries"
 *  → "Get account summaries". Leaves already-human strings (with spaces) alone. */
export function mcpToolTitle(s: string): string {
  const t = s.includes(' ') ? s : s.replace(/[._-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
