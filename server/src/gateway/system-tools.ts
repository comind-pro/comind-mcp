import { and, desc, eq, inArray } from 'drizzle-orm';
import { applyAuth } from '../auth/apply.js';
import { config } from '../config.js';
import { createConnector } from '../connectors/index.js';
import type { CallResult, ToolDef } from '../connectors/types.js';
import { textResult } from '../connectors/types.js';
import { db, pool } from '../db/client.js';
import { callLogs, groupTools, sources, tools } from '../db/schema.js';
import { mcpToolName } from '../lib/tool-name.js';
import { resolveSourceConfig } from '../secrets/loader.js';

/** Server identity surfaced via system.version. Mirrors server/package.json. */
const SERVER_NAME = 'ComindMCP';
const SERVER_VERSION = '0.1.0';
const MCP_SDK_VERSION = '1.12.0';

/** Context an authenticated agent carries into a system-tool call.
 *  `scope` distinguishes the two MCP surfaces:
 *   - 'group': /g/:slug/mcp — one virtual server, `groups` holds that one group.
 *   - 'agent': /a/mcp — union endpoint, `groups` holds every reachable group. */
export interface SystemCtx {
  agentId: string;
  ownerId: string;
  scope: 'group' | 'agent';
  groups: { id: string; slug: string; schedulingEnabled?: boolean }[];
}

const groupIdsOf = (ctx: SystemCtx) => ctx.groups.map((g) => g.id);

/** Built-in MCP introspection tools: they describe the server, its sources,
 *  what the agent may call, and recent activity. Read-only, owner+group scoped.
 *  Opt-in per group via `groups.systemTools`; an agent sees the union across its
 *  groups. Mirrors the SELF_CRON_TOOLS pattern in server.ts. */
const SOURCE_STATUS = { type: 'string', enum: ['unknown', 'ok', 'error'] };

const SOURCE_ITEM = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string' },
    status: SOURCE_STATUS,
    status_message: { type: ['string', 'null'] },
    objects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string' },
          product_hint: { type: ['string', 'null'] },
        },
      },
    },
    freshness: {
      type: 'object',
      properties: {
        status_checked_at: { type: ['string', 'null'] },
        objects_checked_at: { type: ['string', 'null'] },
        cached: { type: 'boolean' },
        ttl_seconds: { type: 'number' },
      },
    },
  },
};

const TOOL_ITEM = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    callable: { type: 'string', description: 'Exact tool name to pass to tools/call.' },
    description: { type: ['string', 'null'] },
    category: { type: 'string' },
    source: { type: ['string', 'null'] },
    read_only: { type: ['boolean', 'null'] },
    dangerous: { type: ['boolean', 'null'] },
    permissions: { type: 'array', items: { type: 'string' } },
    recommended_use: { type: 'object' },
    input_schema: { type: 'object' },
    output_schema: { type: ['object', 'null'] },
    examples: { type: 'array', items: { type: 'object' } },
  },
};

const GROUP_ITEM = {
  type: 'object',
  properties: {
    slug: { type: 'string' },
    tools: { type: 'number' },
    scheduling_enabled: { type: ['boolean', 'null'] },
  },
};

export const SYSTEM_TOOLS: ToolDef[] = [
  {
    name: 'system.context',
    title: 'System context',
    description:
      'Orientation for this connection — call this FIRST. Returns who you are (agent, scope: ' +
      'group|agent, owner), the server (name, version, environment, timezone/locale — use this ' +
      'timezone for any "today"/"this week" date math), the V-MCP groups you can reach, the ' +
      'connected data sources with status, and the full catalog of tools you may call (with ' +
      'schemas and categories). Stop guessing what you can do or what timezone you are in. ' +
      'Pass live=true to ping each source now instead of using cached status.',
    inputSchema: {
      type: 'object',
      properties: {
        live: {
          type: 'boolean',
          description: 'Actively ping each source now (slower, authoritative) instead of cached status.',
        },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        identity: {
          type: 'object',
          properties: {
            agent_id: { type: 'string' },
            owner_id: { type: 'string' },
            scope: { type: 'string', enum: ['group', 'agent'] },
            group: { type: ['string', 'null'] },
            groups: { type: 'array', items: { type: 'string' } },
          },
        },
        server: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            version: { type: 'string' },
            mcp_sdk: { type: 'string' },
            build: { type: ['string', 'null'] },
            environment: { type: 'string' },
            url: { type: 'string' },
            server_time: { type: 'string' },
            timezone: { type: ['string', 'null'] },
            locale: { type: ['string', 'null'] },
            status: { type: 'string', enum: ['ok', 'degraded'] },
            db: { type: 'boolean' },
          },
        },
        groups: { type: 'array', items: GROUP_ITEM },
        sources: { type: 'array', items: SOURCE_ITEM },
        tools: { type: 'array', items: TOOL_ITEM },
      },
    },
  },
  {
    name: 'system.debug',
    title: 'System debug',
    description:
      'Recent activity for this agent — call when a tool returns empty or fails, to tell apart ' +
      '"no data" from "a source broke". Returns recent tool calls and recent errors (with messages).',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max rows per list (default 20, max 100).' } },
    },
    outputSchema: {
      type: 'object',
      properties: {
        calls: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string' },
              time: { type: 'string' },
              status: { type: 'string', enum: ['success', 'error'] },
              source: { type: 'string' },
              duration_ms: { type: 'number' },
            },
          },
        },
        errors: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string' },
              time: { type: 'string' },
              source: { type: 'string' },
              error: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
  },
];

/** One-line summary per system tool, for the server `instructions` block. */
const TOOL_HINTS: Record<string, string> = {
  // Hints reference the MCP-safe (underscore) names the client actually sees.
  'system.context':
    'call system_context first to learn your identity, scope, timezone, reachable V-MCPs, ' +
    'connected sources and the full tool catalog — do not guess timezone or what you can do',
  'system.debug': 'call system_debug when a tool returns empty or errors, to tell apart "no data" from a broken source',
};

/** Build the MCP `instructions` string for the enabled system tools (empty when none). */
export function systemInstructions(names: Iterable<string>): string {
  const lines = SYSTEM_TOOLS.filter((t) => new Set(names).has(t.name))
    .map((t) => TOOL_HINTS[t.name])
    .filter(Boolean);
  if (!lines.length) return '';
  return `This server provides built-in introspection tools: ${lines.join('; ')}.`;
}

export const SYSTEM_TOOL_NAMES = new Set<string>(SYSTEM_TOOLS.map((t) => t.name));

/** Resolve an incoming (possibly MCP-sanitized) name to the canonical dotted one. */
export function canonicalSystemToolName(name: string): string | null {
  if (SYSTEM_TOOL_NAMES.has(name)) return name;
  for (const canonical of SYSTEM_TOOL_NAMES) if (mcpToolName(canonical) === name) return canonical;
  return null;
}

/** The system tools enabled by `names`, in canonical order, ignoring unknowns.
 *  Exposed names are MCP-safe (Claude.ai rejects dots); calls resolve back via
 *  canonicalSystemToolName. */
export function pickSystemTools(names: Iterable<string>): ToolDef[] {
  const want = new Set(names);
  return SYSTEM_TOOLS.filter((t) => want.has(t.name)).map((t) => ({ ...t, name: mcpToolName(t.name) }));
}

type ToolRow = typeof tools.$inferSelect;

/** Automation hints for a tool: stored `recommended_use` wins, else derived from
 *  read_only/dangerous. Null = unknown (don't assume safe). */
function recommendedUseOf(t: ToolRow): Record<string, unknown> {
  const stored = (t.recommendedUse ?? {}) as Record<string, unknown>;
  const ro = t.readOnly;
  const dng = t.dangerous;
  return {
    daily_report: stored.daily_report ?? null,
    safe_for_automation: stored.safe_for_automation ?? (ro == null ? null : ro === true && dng !== true),
    requires_user_confirmation: stored.requires_user_confirmation ?? (dng === true ? true : ro === false ? true : null),
  };
}

/** Map a source kind to a coarse category for discover. */
function categoryOf(kind: string): string {
  switch (kind) {
    case 'ga':
      return 'analytics';
    case 'sql':
      return 'database';
    case 'imap':
      return 'email';
    default:
      return 'custom';
  }
}

function clampLimit(args: Record<string, unknown>): number {
  const n = Number(args.limit ?? 20);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(Math.floor(n), 100);
}

/** Visible tools assigned to any of the given groups (deduped by tool id). */
async function visibleToolsForGroups(groupIds: string[]) {
  if (!groupIds.length) return [];
  const links = await db.select().from(groupTools).where(inArray(groupTools.groupId, groupIds));
  const ids = [...new Set(links.map((l) => l.toolId))];
  if (!ids.length) return [];
  const rows = await db.select().from(tools).where(inArray(tools.id, ids));
  return rows.filter((t) => t.visible);
}

/** Distinct sources backing the visible tools the agent can reach. */
async function sourcesForGroups(groupIds: string[]) {
  const visible = await visibleToolsForGroups(groupIds);
  const sourceIds = [...new Set(visible.map((t) => t.sourceId).filter((s): s is string => !!s))];
  if (!sourceIds.length) return [];
  return db.select().from(sources).where(inArray(sources.id, sourceIds));
}

async function dbOk(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/** Recent call logs for this agent, scoped to its groups. */
async function recentLogs(ctx: SystemCtx, limit: number, errorsOnly: boolean) {
  const groupIds = groupIdsOf(ctx);
  const filters = [eq(callLogs.ownerId, ctx.ownerId), eq(callLogs.agentId, ctx.agentId)];
  if (groupIds.length) filters.push(inArray(callLogs.groupId, groupIds));
  if (errorsOnly) filters.push(eq(callLogs.status, 'error'));
  return db
    .select()
    .from(callLogs)
    .where(and(...filters))
    .orderBy(desc(callLogs.ts))
    .limit(limit);
}

/** Emit both a text rendering and structured output matching the tool's outputSchema. */
function json(value: unknown): CallResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

type SourceRow = typeof sources.$inferSelect;
type SourceStatus = { status: SourceRow['status']; message: string | null; checkedAt: Date | null; cached: boolean };

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(onTimeout()), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }).catch(() => {
      clearTimeout(t);
      resolve(onTimeout());
    });
  });
}

/** Actively ping a source's connector and persist the fresh status. Never throws. */
async function liveHealth(row: SourceRow): Promise<SourceStatus> {
  const probe = await withTimeout<{ status: SourceRow['status']; message: string | null }>(
    (async () => {
      const connector = createConnector(
        row.kind,
        await applyAuth(row.id, await resolveSourceConfig(row.config, row.ownerId, row.id)),
      );
      const res = await connector.health();
      return { status: (res.ok ? 'ok' : 'error') as SourceRow['status'], message: res.message ?? null };
    })().catch((e) => ({ status: 'error' as const, message: (e as Error).message })),
    8000,
    () => ({ status: 'error' as const, message: 'health check timed out' }),
  );
  const checkedAt = new Date();
  await db
    .update(sources)
    .set({ status: probe.status, statusMessage: probe.message, statusCheckedAt: checkedAt })
    .where(eq(sources.id, row.id));
  return { ...probe, checkedAt, cached: false };
}

/** Resolve per-source status: cached column, or a live ping when `live` is set. */
async function sourceStatuses(rows: SourceRow[], live: boolean): Promise<Map<string, SourceStatus>> {
  const map = new Map<string, SourceStatus>();
  if (live) {
    await Promise.all(rows.map(async (r) => map.set(r.id, await liveHealth(r))));
  } else {
    for (const r of rows)
      map.set(r.id, {
        status: r.status,
        message: r.statusMessage ?? null,
        checkedAt: r.statusCheckedAt ?? null,
        cached: true,
      });
  }
  return map;
}

/** Dispatch a built-in system.* tool. Read-only; never returns secrets.
 *  Any failure is returned as an MCP error result, never thrown. */
export async function handleSystemTool(
  ctx: SystemCtx,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  try {
    return await dispatch(ctx, name, args);
  } catch (e) {
    return textResult(`system tool failed: ${(e as Error).message}`, true);
  }
}

async function dispatch(ctx: SystemCtx, name: string, args: Record<string, unknown>): Promise<CallResult> {
  switch (name) {
    case 'system.context': {
      const groupIds = groupIdsOf(ctx);
      const tz = Intl.DateTimeFormat().resolvedOptions();
      const [db_ok, srcRows, visible, groupRows] = await Promise.all([
        dbOk(),
        sourcesForGroups(groupIds),
        visibleToolsForGroups(groupIds),
        Promise.all(
          ctx.groups.map(async (g) => ({
            slug: g.slug,
            tools: (await visibleToolsForGroups([g.id])).length,
            scheduling_enabled: g.schedulingEnabled ?? null,
          })),
        ),
      ]);
      const st = await sourceStatuses(srcRows, args.live === true);
      const ttl = config.sourceStatusTtlSeconds;
      const sourcesOut = srcRows.map((s) => {
        const cur = st.get(s.id);
        return {
          id: s.id,
          type: s.kind,
          status: cur?.status ?? s.status,
          status_message: cur?.message ?? null,
          // Queryable objects (GA properties, DB schemas…). Refresh via POST /sources/:id/objects.
          objects: s.objects ?? [],
          freshness: {
            status_checked_at: cur?.checkedAt ? cur.checkedAt.toISOString() : null,
            objects_checked_at: s.objectsCheckedAt ? s.objectsCheckedAt.toISOString() : null,
            cached: cur?.cached ?? true,
            ttl_seconds: ttl,
          },
        };
      });
      const status = db_ok && !sourcesOut.some((s) => s.status === 'error') ? 'ok' : 'degraded';
      const srcById = new Map(srcRows.map((s) => [s.id, s]));
      const toolsOut = visible.map((t) => {
        const src = t.sourceId ? srcById.get(t.sourceId) : undefined;
        return {
          // `name` IS the exact string to pass to tools/call — call it verbatim.
          name: mcpToolName(t.name),
          callable: mcpToolName(t.name),
          description: t.displayName
            ? `${t.displayName}${t.description ? ` — ${t.description}` : ''}`
            : (t.description ?? null),
          category: src ? categoryOf(src.kind) : t.kind === 'virtual' ? 'virtual' : 'custom',
          source: src?.name ?? null,
          read_only: t.readOnly ?? null,
          dangerous: t.dangerous ?? null,
          permissions: t.permissions ?? [],
          recommended_use: recommendedUseOf(t),
          input_schema: t.inputSchema ?? { type: 'object', properties: {} },
          output_schema: t.outputSchema ?? null,
          examples: t.examples ?? [],
        };
      });
      return json({
        identity: {
          agent_id: ctx.agentId,
          owner_id: ctx.ownerId,
          scope: ctx.scope,
          // group: the single group on a group VMCP; null on the agent-wide endpoint.
          group: ctx.scope === 'group' ? (ctx.groups[0]?.slug ?? null) : null,
          groups: ctx.groups.map((g) => g.slug),
        },
        server: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
          mcp_sdk: MCP_SDK_VERSION,
          build: config.buildTime,
          environment: config.serverEnv,
          url: config.publicBaseUrl,
          // Authoritative current server time + timezone — use these for any
          // "today" / "this week" date math instead of guessing.
          server_time: new Date().toISOString(),
          timezone: tz.timeZone ?? null,
          locale: tz.locale ?? null,
          status,
          db: db_ok,
        },
        groups: groupRows,
        sources: sourcesOut,
        tools: toolsOut,
      });
    }

    case 'system.debug': {
      const limit = clampLimit(args);
      const [calls, errs] = await Promise.all([recentLogs(ctx, limit, false), recentLogs(ctx, limit, true)]);
      return json({
        calls: calls.map((r) => ({
          tool: r.toolName,
          time: r.ts,
          status: r.status,
          source: r.source,
          duration_ms: r.durationMs,
        })),
        errors: errs.map((r) => ({
          tool: r.toolName,
          time: r.ts,
          source: r.source,
          error: r.error ?? null,
        })),
      });
    }

    default:
      return textResult(`Unknown system tool: ${name}`, true);
  }
}
