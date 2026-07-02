/** Normalised tool definition exposed by any connector. */
export interface ToolDef {
  /** Raw upstream name (operationId / MCP tool name / declared endpoint name). */
  name: string;
  /** Human-readable name MCP clients show instead of `name`. */
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** JSON Schema for the result, when the connector can derive it (e.g. OpenAPI). */
  outputSchema?: Record<string, unknown>;
  // ---- optional curated discovery metadata (surfaced via system.context) ----
  readOnly?: boolean;
  dangerous?: boolean;
  permissions?: string[];
  /** Correct-call examples: [{ description, input }]. */
  examples?: Array<{ description?: string; input: Record<string, unknown> }>;
  recommendedUse?: { daily_report?: boolean; safe_for_automation?: boolean; requires_user_confirmation?: boolean };
}

/** MCP-style call result. `content` is an array of content blocks.
 *  `structuredContent` (optional) is a JSON value matching the tool's
 *  outputSchema — surfaced to MCP clients as structured output. */
export interface CallResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface HealthResult {
  ok: boolean;
  message?: string;
}

/** A queryable object inside a source: a GA4 property, a DB schema, a mailbox… */
export interface SourceObject {
  /** Stable id to pass to tools (e.g. "properties/123", a schema name). */
  id: string;
  name: string;
  /** Optional kind hint ("property", "schema", "mailbox"). */
  type?: string;
  /** Optional human hint about what product/app this maps to. */
  product_hint?: string | null;
}

/** A connector adapts one upstream source into a uniform tool interface. */
export interface Connector {
  listTools(): Promise<ToolDef[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallResult>;
  health(): Promise<HealthResult>;
  /** Enumerate queryable objects (GA properties, DB schemas, mailboxes). Optional. */
  listObjects?(): Promise<SourceObject[]>;
}

export function textResult(text: string, isError = false): CallResult {
  return { content: [{ type: 'text', text }], isError };
}
