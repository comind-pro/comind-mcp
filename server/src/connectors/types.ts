/** Normalised tool definition exposed by any connector. */
export interface ToolDef {
  /** Raw upstream name (operationId / MCP tool name / declared endpoint name). */
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** MCP-style call result. `content` is an array of content blocks. */
export interface CallResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
}

export interface HealthResult {
  ok: boolean;
  message?: string;
}

/** A connector adapts one upstream source into a uniform tool interface. */
export interface Connector {
  listTools(): Promise<ToolDef[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallResult>;
  health(): Promise<HealthResult>;
}

export function textResult(text: string, isError = false): CallResult {
  return { content: [{ type: 'text', text }], isError };
}
