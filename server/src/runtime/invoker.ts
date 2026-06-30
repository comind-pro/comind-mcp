import { and, eq } from 'drizzle-orm';
import { applyAuth } from '../auth/apply.js';
import { buildMcpOAuthProvider } from '../auth/mcp-oauth.js';
import { runComposite } from '../composite/engine.js';
import { createConnector } from '../connectors/index.js';
import type { CallResult } from '../connectors/types.js';
import { textResult } from '../connectors/types.js';
import { db } from '../db/client.js';
import { callLogs, composites, sources, tools, virtuals } from '../db/schema.js';
import { newId } from '../lib/id.js';
import { resolveSourceConfig } from '../secrets/loader.js';
import { runVirtual, staticResult } from './virtual.js';

export interface InvokeContext {
  ownerId: string; // tools are resolved only within this user's namespace
  agentId?: string | null;
  groupId?: string | null;
  /** How the call was triggered (for analytics). Defaults to 'live'. */
  source?: 'live' | 'test' | 'schedule';
}

const MAX_DEPTH = 5;

function estimateTokens(result: CallResult): number {
  const len = result.content.reduce((n, c) => n + (typeof c.text === 'string' ? c.text.length : 0), 0);
  return Math.ceil(len / 4);
}

/** When a native tool declares an outputSchema and its result body is JSON,
 *  surface the parsed value as structuredContent (MCP structured output). */
function withStructured(result: CallResult, outputSchema: unknown): CallResult {
  if (!outputSchema || result.isError || result.structuredContent !== undefined) return result;
  const text = result.content.find((c) => typeof c.text === 'string')?.text;
  if (!text) return result;
  try {
    return { ...result, structuredContent: JSON.parse(text) };
  } catch {
    return result; // not JSON — leave as text
  }
}

/**
 * Central tool runtime shared by the gateway, composites and the scheduler.
 * Resolves a tool by registry name and dispatches: native → connector,
 * composite → recursive engine. Every invocation is logged (best-effort).
 */
export async function invokeTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: InvokeContext,
  depth = 0,
): Promise<CallResult> {
  const startedAt = Date.now();
  const result = await dispatch(toolName, args, ctx, depth);
  // Observability: record each call. Never let logging break the call.
  void db
    .insert(callLogs)
    .values({
      id: newId(),
      ownerId: ctx.ownerId,
      groupId: ctx.groupId ?? null,
      agentId: ctx.agentId ?? null,
      toolName,
      source: ctx.source ?? 'live',
      status: result.isError ? 'error' : 'success',
      durationMs: Date.now() - startedAt,
      tokensEst: estimateTokens(result),
      error: result.isError
        ? result.content
            .map((c) => c.text)
            .join('\n')
            .slice(0, 500)
        : null,
      ts: new Date(),
    })
    .catch(() => {});
  return result;
}

async function dispatch(
  toolName: string,
  args: Record<string, unknown>,
  ctx: InvokeContext,
  depth: number,
): Promise<CallResult> {
  if (depth > MAX_DEPTH) return textResult(`Max composite depth exceeded at ${toolName}`, true);

  // Owner-scoped: never resolve another user's tool with the same name.
  const [tool] = await db
    .select()
    .from(tools)
    .where(and(eq(tools.name, toolName), eq(tools.ownerId, ctx.ownerId)));
  if (!tool) return textResult(`Unknown tool: ${toolName}`, true);

  if (tool.kind === 'composite') {
    const [comp] = await db.select().from(composites).where(eq(composites.toolId, tool.id));
    if (!comp) return textResult(`Composite definition missing for ${toolName}`, true);
    return runComposite(comp.definition, args, (name, a, d) => invokeTool(name, a, ctx, d), depth);
  }

  if (tool.kind === 'virtual') {
    const [v] = await db.select().from(virtuals).where(eq(virtuals.toolId, tool.id));
    if (!v) return textResult(`Virtual definition missing for ${toolName}`, true);
    if (!v.executable) {
      // descriptive: return the user-defined static response body when set,
      // otherwise a catalog entry describing the tool.
      if (v.response !== undefined && v.response !== null) return staticResult(v.response);
      const spec = {
        kind: 'virtual',
        executable: false,
        name: tool.name,
        description: tool.description ?? null,
        input_schema: tool.inputSchema ?? null,
        output_schema: tool.outputSchema ?? null,
      };
      return { content: [{ type: 'text', text: JSON.stringify(spec) }], structuredContent: spec };
    }
    // read-only enforcement: a tool declared read_only may only use safe methods.
    const method = String((v.request as { method?: string })?.method ?? 'GET').toUpperCase();
    if (tool.readOnly === true && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      return textResult(`Tool ${toolName} is marked read-only but its request uses ${method}.`, true);
    }
    return withStructured(await runVirtual(v.request, args, ctx.ownerId), tool.outputSchema);
  }

  // native
  if (!tool.sourceId) return textResult(`Native tool ${toolName} has no source`, true);
  const [source] = await db.select().from(sources).where(eq(sources.id, tool.sourceId));
  if (!source) return textResult(`Source missing for ${toolName}`, true);

  try {
    const full = await resolveSourceConfig(source.config, source.ownerId, source.id);
    const authBlock = full.auth as { type?: string; scope?: string; clientId?: string } | undefined;

    // MCP-native OAuth: hand the SDK provider to the transport (auto Bearer + refresh).
    if (source.kind === 'mcp' && authBlock?.type === 'mcp_oauth') {
      const provider = buildMcpOAuthProvider(source.id, { scope: authBlock.scope, clientId: authBlock.clientId });
      const connector = createConnector('mcp', full, { authProvider: provider });
      return withStructured(await connector.callTool(tool.upstreamName ?? tool.name, args), tool.outputSchema);
    }

    const resolved = await applyAuth(source.id, full);
    const connector = createConnector(source.kind, resolved);
    return withStructured(await connector.callTool(tool.upstreamName ?? tool.name, args), tool.outputSchema);
  } catch (err) {
    // Fault isolation: one bad upstream must not crash the caller.
    return textResult(err instanceof Error ? err.message : String(err), true);
  }
}
