import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { sourceKind } from '../connectors/index.js';
import type { CallResult, ToolDef } from '../connectors/types.js';
import { textResult } from '../connectors/types.js';
import { db } from '../db/client.js';
import { agentKeys, callLogs, projects } from '../db/schema.js';
import { newId } from '../lib/id.js';
import { type Scope, scopeForOwner } from '../lib/scope.js';
import { mcpToolName } from '../lib/tool-name.js';
import { createAgent, ownedAgent, revokeAgent } from '../services/agents.js';
import { addGroupTool, createGroup, setGroupTools } from '../services/groups.js';
import {
  createNode,
  deleteNode,
  grantAccess,
  listNodes,
  previewDelete,
  previewRevoke,
  revokeAccess,
} from '../services/projects.js';
import { declareSecret } from '../services/secrets.js';
import {
  createSource,
  getSource,
  importSource,
  isErr,
  listSources,
  previewImportRemovals,
  type ServiceErr,
  testSource,
} from '../services/sources.js';
import {
  compositeCreateBody,
  createCompositeTool,
  createPythonTool,
  createVirtualTool,
  listTools,
  pythonCreateBody,
  testTool,
  virtualCreateBody,
} from '../services/tools.js';
import { json } from './system-tools.js';

/** The COO calling a project.* tool: its own node is the scope. */
export interface ProjectCtx {
  agentId: string;
  ownerId: string;
  projectId: string;
}

const invalid = (e: z.ZodError): CallResult =>
  textResult(
    `invalid arguments: ${e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    true,
  );

const fail = (code: string, detail?: unknown): CallResult =>
  textResult(`${code}${detail ? `: ${JSON.stringify(detail)}` : ''}`, true);

/** Service result → MCP result. Services return a ServiceErr object or a bare error string. */
function out<T>(r: T, map: (v: Exclude<T, string | ServiceErr>) => unknown = (v) => v): CallResult {
  if (typeof r === 'string') return r === 'ok' ? json({ ok: true }) : fail(r);
  if (isErr(r)) return fail(r.error, r.detail);
  return json(map(r as Exclude<T, string | ServiceErr>));
}

const str = { type: 'string' };
const bool = { type: 'boolean' };
const strArr = { type: 'array', items: str };
const CONFIRM = { type: 'boolean', description: 'Apply the change. Without it you get a preview.' };
const RES_TYPE = { type: 'string', enum: ['source', 'tool', 'secret'] };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});

const resType = z.enum(['source', 'tool', 'secret']);
const grant = z.object({ projectId: z.string(), resourceType: resType, resourceId: z.string() });

// args are validated by `Def.args` before run
type Run = (scope: Scope, ctx: ProjectCtx, a: any) => Promise<CallResult>;
interface Def {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  args: z.ZodTypeAny;
  run: Run;
}

const DEFS: Def[] = [
  {
    name: 'project.list',
    description: 'The project tree under your node (teams and projects you administer).',
    inputSchema: obj({}),
    args: z.object({}),
    run: async (scope) =>
      json({
        nodes: (await listNodes(scope)).map((n) => ({
          id: n.id,
          parentId: n.parentId,
          kind: n.kind,
          name: n.name,
          slug: n.slug,
          path: n.path,
        })),
      }),
  },
  {
    name: 'project.create_child',
    description: 'Create a team or project under parentId (default: your node).',
    inputSchema: obj({ kind: { type: 'string', enum: ['team', 'project'] }, name: str, slug: str, parentId: str }, [
      'kind',
      'name',
    ]),
    args: z.object({
      kind: z.enum(['team', 'project']),
      name: z.string().min(1),
      slug: z.string().optional(),
      parentId: z.string().optional(),
    }),
    run: async (scope, ctx, a) => out(await createNode(scope, { ...a, parentId: a.parentId ?? ctx.projectId })),
  },
  {
    name: 'project.delete',
    description:
      'Delete a descendant node with everything in it. Without confirm returns counts of what would be removed.',
    inputSchema: obj({ id: str, confirm: CONFIRM }, ['id']),
    args: z.object({ id: z.string(), confirm: z.boolean().optional() }),
    run: async (scope, _ctx, a) => {
      const [target] = await db
        .select({ path: projects.path })
        .from(projects)
        .where(and(eq(projects.id, a.id), eq(projects.ownerId, scope.ownerId)));
      // the own node or an ancestor: its path is a prefix of ours
      if (target && scope.nodePath.startsWith(target.path))
        return fail('not_allowed: cannot delete your own node or an ancestor');
      if (!a.confirm) return out(await previewDelete(scope, a.id), (p) => ({ preview: true, ...p }));
      return out(await deleteNode(scope, a.id));
    },
  },
  {
    name: 'project.access_create',
    description: 'Share a source, tool or secret you can see with a node in your subtree.',
    inputSchema: obj({ projectId: str, resourceType: RES_TYPE, resourceId: str }, [
      'projectId',
      'resourceType',
      'resourceId',
    ]),
    args: grant,
    run: async (scope, ctx, a) => out(await grantAccess(scope, { ...a, grantedBy: ctx.agentId })),
  },
  {
    name: 'project.access_revoke',
    description: 'Revoke a share. Without confirm lists the workspaces that would lose tools.',
    inputSchema: obj({ projectId: str, resourceType: RES_TYPE, resourceId: str, confirm: CONFIRM }, [
      'projectId',
      'resourceType',
      'resourceId',
    ]),
    args: grant.extend({ confirm: z.boolean().optional() }),
    run: async (scope, _ctx, { confirm, ...g }) =>
      confirm
        ? out(await revokeAccess(scope, g))
        : out(await previewRevoke(scope, g), (p) => ({ preview: true, ...p })),
  },
  {
    name: 'project.connections_list',
    description: 'Data sources you can see: id, name, kind, status, owning project, and whether it is shared in.',
    inputSchema: obj({}),
    args: z.object({}),
    run: async (scope) => {
      const mine = new Set((await listNodes(scope)).map((n) => n.id));
      return json({
        connections: (await listSources(scope)).map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          status: s.status,
          statusMessage: s.statusMessage,
          projectId: s.projectId,
          sharedFrom: !mine.has(s.projectId),
        })),
      });
    },
  },
  {
    name: 'project.connection_describe',
    description: 'A source: cached objects (GA properties, tables, mailboxes…) and its tools with schemas.',
    inputSchema: obj({ id: str }, ['id']),
    args: z.object({ id: z.string() }),
    run: async (scope, _ctx, a) => {
      const s = await getSource(scope, a.id);
      if (isErr(s)) return fail(s.error);
      const ts = await listTools(scope, { sourceId: s.id });
      return json({
        id: s.id,
        name: s.name,
        kind: s.kind,
        status: s.status,
        objects: s.objects ?? [],
        objectsCheckedAt: s.objectsCheckedAt,
        tools: ts.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          readOnly: t.readOnly,
          dangerous: t.dangerous,
        })),
      });
    },
  },
  {
    name: 'project.connection_create',
    description:
      'Create a source in your node. Put credentials as ${secret.NAME} references (declare them with ' +
      'project_secret_declare) — never raw secret values.',
    inputSchema: obj({ name: str, kind: { type: 'string', enum: sourceKind.options }, config: { type: 'object' } }, [
      'name',
      'kind',
      'config',
    ]),
    args: z.object({ name: z.string().min(1), kind: sourceKind, config: z.record(z.unknown()) }),
    run: async (scope, ctx, a) =>
      out(await createSource(scope, a, ctx.agentId), (s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        status: s.status,
        projectId: s.projectId,
      })),
  },
  {
    name: 'project.connection_test',
    description: 'Health-check a source.',
    inputSchema: obj({ id: str }, ['id']),
    args: z.object({ id: z.string() }),
    run: async (scope, _ctx, a) => out(await testSource(scope, a.id)),
  },
  {
    name: 'project.connection_import',
    description:
      "Import a source's tools; returns a per-tool report. force refreshes existing tools and soft-deletes " +
      'ones the source dropped — force without confirm only previews those removals.',
    inputSchema: obj({ id: str, force: bool, confirm: CONFIRM }, ['id']),
    args: z.object({ id: z.string(), force: z.boolean().optional(), confirm: z.boolean().optional() }),
    run: async (scope, ctx, a) => {
      if (a.force && !a.confirm) return out(await previewImportRemovals(scope, a.id), (p) => ({ preview: true, ...p }));
      return out(await importSource(scope, a.id, { force: !!a.force, createdByAgentId: ctx.agentId }), (r) => ({
        ...r,
        tools: r.tools.map((t) => ({ id: t.id, name: t.name })),
      }));
    },
  },
  {
    name: 'project.secret_declare',
    description:
      'Declare a secret without a value (the owner fills it in admin). Returns the ${secret.NAME} reference to use.',
    inputSchema: obj({ name: str, sourceId: str }, ['name']),
    args: z.object({ name: z.string().min(1), sourceId: z.string().optional() }),
    run: async (scope, ctx, a) =>
      out(await declareSecret(scope, a, ctx.agentId), (s) => ({
        id: s.id,
        name: s.name,
        pending: s.pending,
        reference: `\${secret.${s.name}}`,
      })),
  },
  {
    name: 'project.tool_candidate_create',
    description:
      'Create a virtual, composite or python tool in your node, in no workspace (staging). `definition` is the ' +
      'same body as the admin API for that kind.',
    inputSchema: obj(
      { kind: { type: 'string', enum: ['virtual', 'composite', 'python'] }, definition: { type: 'object' } },
      ['kind', 'definition'],
    ),
    args: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('virtual'), definition: virtualCreateBody }),
      z.object({ kind: z.literal('composite'), definition: compositeCreateBody }),
      z.object({ kind: z.literal('python'), definition: pythonCreateBody }),
    ]),
    run: async (scope, ctx, a) => {
      const create = { virtual: createVirtualTool, composite: createCompositeTool, python: createPythonTool }[
        a.kind as 'virtual'
      ];
      return out(await create(scope, a.definition, ctx.agentId), (t) => ({
        id: t.id,
        name: t.name,
        kind: t.kind,
        projectId: t.projectId,
      }));
    },
  },
  {
    name: 'project.tool_candidate_test',
    description: 'Run a tool you can see with args and return its result.',
    inputSchema: obj({ toolId: str, args: { type: 'object' } }, ['toolId']),
    args: z.object({ toolId: z.string(), args: z.record(z.unknown()).optional() }),
    run: async (scope, ctx, a) => {
      const r = await testTool(scope, a.toolId, a.args ?? {}, { agentId: ctx.agentId });
      return isErr(r) ? fail(r.error, r.detail) : r;
    },
  },
  {
    name: 'project.tool_candidate_promote',
    description: 'Add one tool to a workspace.',
    inputSchema: obj({ toolId: str, groupId: str }, ['toolId', 'groupId']),
    args: z.object({ toolId: z.string(), groupId: z.string() }),
    run: async (scope, _ctx, a) => out(await addGroupTool(scope, a.groupId, a.toolId)),
  },
  {
    name: 'project.workspace_create',
    description: 'Create a workspace (V-MCP group) in your node, optionally with its tool set.',
    inputSchema: obj({ name: str, slug: str, toolIds: strArr }, ['name']),
    args: z.object({ name: z.string().min(1), slug: z.string().optional(), toolIds: z.array(z.string()).optional() }),
    run: async (scope, ctx, a) => {
      // ponytail: a rejected tool set leaves the (empty) group behind; the error names it.
      const g = await createGroup(scope, { name: a.name, slug: a.slug }, ctx.agentId);
      if (a.toolIds?.length) {
        const r = await setGroupTools(scope, g.id, a.toolIds);
        if (isErr(r)) return fail(r.error, { ...(r.detail as object), groupId: g.id });
      }
      return json({ id: g.id, slug: g.slug, name: g.name, projectId: g.projectId, toolIds: a.toolIds ?? [] });
    },
  },
  {
    name: 'project.workspace_set_tools',
    description: "Replace a workspace's tool set.",
    inputSchema: obj({ groupId: str, toolIds: strArr }, ['groupId', 'toolIds']),
    args: z.object({ groupId: z.string(), toolIds: z.array(z.string()) }),
    run: async (scope, _ctx, a) => out(await setGroupTools(scope, a.groupId, a.toolIds)),
  },
  {
    name: 'project.agent_mcp_provision',
    description:
      'Create an agent (default role lead) in projectId (default: your node) with access to groupIds. Returns ' +
      'its MCP endpoints and API key — shown only this once.',
    inputSchema: obj({ name: str, projectId: str, groupIds: strArr, role: { type: 'string', enum: ['lead', 'coo'] } }, [
      'name',
    ]),
    args: z.object({
      name: z.string().min(1),
      projectId: z.string().optional(),
      groupIds: z.array(z.string()).default([]),
      role: z.enum(['lead', 'coo']).default('lead'),
    }),
    run: async (scope, ctx, a) =>
      out(
        await createAgent(
          scope,
          { name: a.name, role: a.role, projectId: a.projectId ?? ctx.projectId, groupIds: a.groupIds },
          ctx.agentId,
        ),
        (r) => ({
          agentId: r.agent.id,
          role: r.agent.role,
          projectId: r.agent.projectId,
          apiKey: r.apiKey,
          endpoints: r.endpoints,
        }),
      ),
  },
  {
    name: 'project.agent_revoke',
    description: "Archive all of an agent's keys. Without confirm returns how many keys would be revoked.",
    inputSchema: obj({ agentId: str, confirm: CONFIRM }, ['agentId']),
    args: z.object({ agentId: z.string(), confirm: z.boolean().optional() }),
    run: async (scope, ctx, a) => {
      if (a.agentId === ctx.agentId) return fail('not_allowed: cannot revoke yourself');
      if (a.confirm) return out(await revokeAgent(scope, a.agentId), (r) => ({ revoked: true, ...r }));
      if (!(await ownedAgent(scope, a.agentId))) return fail('not_found');
      const keys = await db
        .select({ id: agentKeys.id })
        .from(agentKeys)
        .where(and(eq(agentKeys.agentId, a.agentId), eq(agentKeys.archived, false)));
      return json({ preview: true, agentId: a.agentId, keys: keys.length });
    },
  },
];

const BY_NAME = new Map(DEFS.map((d) => [d.name, d]));

export const PROJECT_TOOLS: ToolDef[] = DEFS.map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
}));

export const PROJECT_TOOL_NAMES = new Set<string>(BY_NAME.keys());

/** Resolve an incoming (possibly MCP-sanitized) name to the canonical dotted one. */
export function canonicalProjectToolName(name: string): string | null {
  if (PROJECT_TOOL_NAMES.has(name)) return name;
  for (const canonical of PROJECT_TOOL_NAMES) if (mcpToolName(canonical) === name) return canonical;
  return null;
}

/** All project tools with MCP-safe names (Claude.ai rejects dots). */
export function pickProjectTools(): ToolDef[] {
  return PROJECT_TOOLS.map((t) => ({ ...t, name: mcpToolName(t.name) }));
}

const redact = (args: Record<string, unknown>) => ({
  ...args,
  ...('config' in args ? { config: '[redacted]' } : {}),
  ...('definition' in args ? { definition: '[redacted]' } : {}),
});

/** Dispatch a project.* tool for a COO, scoped to its node, and audit it (args always). */
export async function handleProjectTool(
  ctx: ProjectCtx,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  const started = Date.now();
  const result = await dispatch(ctx, name, args);
  void db
    .insert(callLogs)
    .values({
      id: newId(),
      ownerId: ctx.ownerId,
      projectId: ctx.projectId,
      groupId: null,
      agentId: ctx.agentId,
      toolName: name,
      source: 'live',
      status: result.isError ? 'error' : 'success',
      durationMs: Date.now() - started,
      tokensEst: null,
      error: result.isError ? result.content.map((c) => c.text ?? '').join('\n') : null,
      // config / definition are free-form and could inline a literal token: never log them
      args: JSON.stringify(redact(args)).slice(0, 2000),
      ts: new Date(),
    })
    .catch(() => {});
  return result;
}

async function dispatch(ctx: ProjectCtx, name: string, args: Record<string, unknown>): Promise<CallResult> {
  const def = BY_NAME.get(name);
  if (!def) return textResult(`Unknown project tool: ${name}`, true);
  const parsed = def.args.safeParse(args);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const scope = await scopeForOwner(ctx.ownerId, ctx.projectId);
    if (!scope) return textResult('project not found', true);
    return await def.run(scope, ctx, parsed.data);
  } catch (e) {
    // createSource throws ZodError on a config that does not fit the kind
    if (e instanceof z.ZodError) return invalid(e);
    return textResult(`project tool failed: ${(e as Error).message}`, true);
  }
}
