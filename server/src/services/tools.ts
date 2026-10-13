import { and, eq, inArray, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { compositeDefinitionSchema, hasPythonStep } from '../composite/engine.js';
import { config } from '../config.js';
import type { CallResult } from '../connectors/types.js';
import { db } from '../db/client.js';
import { composites, liveTool, scripts, tools, virtuals } from '../db/schema.js';
import { hasFeature, PYTHON_TOOLS } from '../lib/features.js';
import { newId } from '../lib/id.js';
import { granted, inScope, type Scope, usableBy } from '../lib/scope.js';
import { invokeTool } from '../runtime/invoker.js';
import { isErr, NOT_FOUND, type ServiceErr, type ToolRow } from './sources.js';

export type ToolKind = ToolRow['kind'];

/** Tools a scope may read: its subtree, grants on the tool, or grants on its source. */
export const toolVisibleCond = (scope: Scope) =>
  or(inScope(tools.projectId, tools.id, 'tool', scope), granted(tools.sourceId, 'source', scope.nodeId)) as SQL;

/** Tools a single node may put into its workspaces (rule 1). */
export const toolUsableCond = (nodeId: string) =>
  or(usableBy(tools.projectId, tools.id, 'tool', nodeId), granted(tools.sourceId, 'source', nodeId)) as SQL;

export const requestSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  url: z.string().min(1),
  headers: z.record(z.string()).optional(),
  query: z.record(z.string()).optional(),
  body: z.unknown().optional(),
});

export const virtualCreateBody = z.object({
  name: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.unknown()).nullable().optional(),
  outputSchema: z.record(z.unknown()).nullable().optional(),
  // executable → we HTTP-proxy `request`. descriptive → no endpoint, request optional.
  executable: z.boolean().optional(),
  request: requestSchema.optional(),
  // descriptive: static response body returned on call.
  response: z.unknown().optional(),
});
export type VirtualCreateInput = z.infer<typeof virtualCreateBody>;

export const compositeCreateBody = z.object({
  name: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().optional(),
  definition: compositeDefinitionSchema,
});
export type CompositeCreateInput = z.infer<typeof compositeCreateBody>;

export const codeField = z.string().min(1).max(config.pythonMaxCodeBytes);
export const pythonCreateBody = z.object({
  name: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().optional(),
  code: codeField,
  inputSchema: z.record(z.unknown()).nullable().optional(),
  outputSchema: z.record(z.unknown()).nullable().optional(),
});
export type PythonCreateInput = z.infer<typeof pythonCreateBody>;

const FEATURE_OFF: ServiceErr = { error: 'feature_disabled', detail: { feature: PYTHON_TOOLS } };

export async function listTools(
  scope: Scope,
  filter: { sourceId?: string; kind?: ToolKind; visible?: boolean } = {},
): Promise<ToolRow[]> {
  const filters: SQL[] = [eq(tools.ownerId, scope.ownerId), liveTool(), toolVisibleCond(scope)];
  if (filter.sourceId) filters.push(eq(tools.sourceId, filter.sourceId));
  if (filter.kind) filters.push(eq(tools.kind, filter.kind));
  if (filter.visible !== undefined) filters.push(eq(tools.visible, filter.visible));
  return db
    .select()
    .from(tools)
    .where(and(...filters));
}

export async function getTool(scope: Scope, id: string): Promise<ToolRow | ServiceErr> {
  const [row] = await db
    .select()
    .from(tools)
    .where(and(eq(tools.id, id), eq(tools.ownerId, scope.ownerId), liveTool(), toolVisibleCond(scope)));
  return row ?? NOT_FOUND;
}

/** Referenced step tools must be usable by the project (rule 1). Python steps reference none. */
export async function missingRefs(steps: { tool?: string }[], ownerId: string, projectId: string): Promise<string[]> {
  const refNames = [...new Set(steps.map((s) => s.tool).filter((n): n is string => Boolean(n)))];
  if (!refNames.length) return [];
  const found = await db
    .select()
    .from(tools)
    .where(and(inArray(tools.name, refNames), eq(tools.ownerId, ownerId), liveTool(), toolUsableCond(projectId)));
  return refNames.filter((n) => !found.some((t) => t.name === n));
}

async function nameTaken(ownerId: string, name: string): Promise<boolean> {
  const [clash] = await db
    .select({ id: tools.id })
    .from(tools)
    .where(and(eq(tools.name, name), eq(tools.ownerId, ownerId)));
  return !!clash;
}

/** Insert a custom tool row plus its kind table row in one transaction. */
async function insertCustom(
  scope: Scope,
  kind: 'virtual' | 'composite' | 'python',
  base: {
    name: string;
    displayName?: string;
    description?: string;
    inputSchema?: Record<string, unknown> | null;
    outputSchema?: Record<string, unknown> | null;
  },
  createdByAgentId: string | null,
  detail: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], toolId: string) => Promise<unknown>,
): Promise<ToolRow> {
  const toolId = newId();
  await db.transaction(async (tx) => {
    await tx.insert(tools).values({
      id: toolId,
      ownerId: scope.ownerId,
      projectId: scope.createIn,
      createdByAgentId,
      sourceId: null,
      kind,
      name: base.name,
      upstreamName: null,
      displayName: base.displayName ?? base.name,
      description: base.description ?? null,
      inputSchema: base.inputSchema ?? null,
      outputSchema: base.outputSchema ?? null,
      visible: true,
      createdAt: new Date(),
    });
    await detail(tx, toolId);
  });
  const [row] = await db.select().from(tools).where(eq(tools.id, toolId));
  return row;
}

export async function createVirtualTool(
  scope: Scope,
  input: VirtualCreateInput,
  createdByAgentId: string | null,
): Promise<ToolRow | ServiceErr> {
  const executable = input.executable ?? true;
  if (executable && !input.request) return { error: 'validation', detail: { error: 'request_required' } };
  if (await nameTaken(scope.ownerId, input.name)) return { error: 'name_taken' };
  return insertCustom(scope, 'virtual', input, createdByAgentId, (tx, toolId) =>
    tx
      .insert(virtuals)
      .values({ id: newId(), toolId, executable, request: input.request ?? {}, response: input.response ?? null }),
  );
}

export async function createCompositeTool(
  scope: Scope,
  input: CompositeCreateInput,
  createdByAgentId: string | null,
): Promise<ToolRow | ServiceErr> {
  const missing = await missingRefs(input.definition.steps, scope.ownerId, scope.createIn);
  if (missing.length) return { error: 'unknown_tools', detail: { missing } };
  if (hasPythonStep(input.definition) && !(await hasFeature(scope.ownerId, PYTHON_TOOLS))) return FEATURE_OFF;
  if (await nameTaken(scope.ownerId, input.name)) return { error: 'name_taken' };
  const base = {
    ...input,
    inputSchema: input.definition.inputSchema ?? null,
    outputSchema: input.definition.outputSchema ?? null,
  };
  return insertCustom(scope, 'composite', base, createdByAgentId, (tx, toolId) =>
    tx.insert(composites).values({ id: newId(), toolId, definition: input.definition }),
  );
}

export async function createPythonTool(
  scope: Scope,
  input: PythonCreateInput,
  createdByAgentId: string | null,
): Promise<ToolRow | ServiceErr> {
  if (!(await hasFeature(scope.ownerId, PYTHON_TOOLS))) return FEATURE_OFF;
  if (await nameTaken(scope.ownerId, input.name)) return { error: 'name_taken' };
  return insertCustom(scope, 'python', input, createdByAgentId, (tx, toolId) =>
    tx.insert(scripts).values({ id: newId(), toolId, code: input.code }),
  );
}

export async function testTool(
  scope: Scope,
  id: string,
  args: Record<string, unknown>,
  ctx: { agentId: string | null },
): Promise<CallResult | ServiceErr> {
  const tool = await getTool(scope, id);
  if (isErr(tool)) return tool;
  return invokeTool(tool.name, args, { ownerId: scope.ownerId, groupId: null, agentId: ctx.agentId, source: 'test' });
}
