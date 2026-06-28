const BASE = (import.meta.env.VITE_API_BASE as string) || 'http://127.0.0.1:8787';

const TOKEN_KEY = 'comind_token';
export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

/** Raised on 401 so the app can drop to the login screen. */
export class Unauthorized extends Error {}

interface ZodIssue { path?: (string | number)[]; message?: string }

/** Build a human-readable error from a server error body. For validation
 *  failures, spell out each offending field (path) and why. */
function formatApiError(data: any, status: number): string {
  const base = data?.error || data?.message || `HTTP ${status}`;
  const issues: ZodIssue[] | undefined = data?.issues;
  if (Array.isArray(issues) && issues.length) {
    const lines = issues.map((i) => {
      const where = i.path && i.path.length ? i.path.join('.') : '(root)';
      return `• ${where}: ${i.message ?? 'invalid'}`;
    });
    return `${base}:\n${lines.join('\n')}`;
  }
  return base;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = tokenStore.get();
  if (token) headers.authorization = `Bearer ${token}`;
  const opts: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 401) {
    tokenStore.clear();
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('comind-unauthorized'));
    throw new Unauthorized('unauthorized');
  }
  if (!res.ok) throw new Error(formatApiError(data, res.status));
  return data as T;
}

export interface AuthUser {
  id: string;
  email: string;
}

export const api = {
  get: <T>(p: string) => req<T>('GET', p),
  post: <T>(p: string, b?: unknown) => req<T>('POST', p, b),
  patch: <T>(p: string, b?: unknown) => req<T>('PATCH', p, b),
  put: <T>(p: string, b?: unknown) => req<T>('PUT', p, b),
  del: <T>(p: string) => req<T>('DELETE', p),
  base: BASE,
  async register(email: string, password: string) {
    const r = await req<{ token: string; user: AuthUser }>('POST', '/auth/register', { email, password });
    tokenStore.set(r.token);
    return r.user;
  },
  async login(email: string, password: string) {
    const r = await req<{ token: string; user: AuthUser }>('POST', '/auth/login', { email, password });
    tokenStore.set(r.token);
    return r.user;
  },
  me: () => req<AuthUser>('GET', '/auth/me'),
  logout: () => tokenStore.clear(),
};

export interface SourceObject {
  id: string;
  name: string;
  type?: string;
  product_hint?: string | null;
}
export interface Source {
  id: string;
  name: string;
  kind: 'mcp' | 'openapi' | 'http' | 'imap' | 'sql' | 'ga';
  config: Record<string, unknown>;
  status: string;
  statusMessage: string | null;
  objects?: SourceObject[];
  objectsCheckedAt?: string | null;
}
export interface ToolExample {
  description?: string;
  input: Record<string, unknown>;
}
export interface RecommendedUse {
  daily_report?: boolean;
  safe_for_automation?: boolean;
  requires_user_confirmation?: boolean;
}
export interface Tool {
  id: string;
  sourceId: string | null;
  kind: 'native' | 'composite';
  name: string;
  displayName: string | null;
  description: string | null;
  visible: boolean;
  inputSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
  readOnly?: boolean | null;
  dangerous?: boolean | null;
  permissions?: string[];
  examples?: ToolExample[];
  recommendedUse?: RecommendedUse | null;
}
export interface Group {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  schedulingEnabled: boolean;
}

/** Built-in system.* introspection tools an agent can expose, with short labels
 *  and an example response so users see what each returns. */
export const SYSTEM_TOOLS: { name: string; label: string; example: string }[] = [
  {
    name: 'system.context',
    label: 'Who am I, scope, groups, sources, tool catalog — one call',
    example: `{
  "identity": {
    "agent_id": "cmd_ag_…",
    "owner_id": "usr_…",
    "scope": "group",                 // "agent" on /a/mcp
    "group": "ops-reporting",         // null on /a/mcp
    "groups": ["ops-reporting"]
  },
  "server": {
    "name": "ComindMCP", "version": "0.1.0", "mcp_sdk": "1.12.0",
    "environment": "prod", "url": "https://mcp.comind.pro",
    "server_time": "2026-06-28T11:40:00Z",   // use for "today"/"this week"
    "timezone": "Europe/Kyiv", "locale": "en-US",
    "status": "ok", "db": true
  },
  "groups":  [ { "slug": "ops-reporting", "tools": 7, "scheduling_enabled": true } ],
  "sources": [ {
    "id": "src_ga", "type": "ga", "status": "ok", "status_message": null,
    "freshness": { "status_checked_at": "2026-06-28T11:35:00Z", "cached": true, "ttl_seconds": 300 }
  } ],
  "tools":   [ {
    "name": "ga.run_report",
    "callable": "ga.run_report",            // exact string for tools/call
    "description": "Run a GA4 report",
    "category": "analytics", "source": "Google Analytics",
    "read_only": true, "dangerous": false, "permissions": ["ga4.read"],
    "recommended_use": { "daily_report": true, "safe_for_automation": true, "requires_user_confirmation": false },
    "input_schema": { "type": "object", "properties": { "…": {} } },
    "output_schema": null,
    "examples": [ {
      "description": "7d traffic by date",
      "input": { "property": "properties/527034943", "startDate": "7daysAgo",
                 "endDate": "today", "dimensions": ["date"],
                 "metrics": ["activeUsers", "sessions"] }
    } ]
  } ]
}
// pass { "live": true } to ping each source instead of cached status`,
  },
  {
    name: 'system.debug',
    label: 'Recent tool calls + errors (for debugging)',
    example: `{
  "calls": [
    { "tool": "ga.run_report", "time": "2026-06-28T10:10:00Z",
      "status": "success", "source": "live", "duration_ms": 420 }
  ],
  "errors": [
    { "tool": "ga.run_report", "time": "2026-06-28T10:00:00Z",
      "source": "live", "error": "AUTH_EXPIRED: token expired" }
  ]
}`,
  },
];
export interface AgentGroupGrant {
  id: string;
  name: string;
  slug: string;
  endpoint: string;
}
export interface Agent {
  id: string;
  name: string;
  apiKeyPrefix?: string | null;
  keyCount?: number;
  groups?: AgentGroupGrant[];
  systemTools?: string[];
}
export interface AgentKey {
  id: string;
  prefix: string;
  label: string | null;
  archived: boolean;
  createdAt: number | string;
}
export interface Schedule {
  id: string;
  groupId: string;
  cron: string;
  toolName: string;
  lastRun: number | null;
  createdBy: string;
}
export interface Secret {
  id: string;
  name: string;
  sourceId: string | null;
  sourceName: string | null;
  displayName: string;
  kind: 'env' | 'encrypted';
  envRef: string | null;
}
export interface CallLog {
  id: string;
  toolName: string;
  status: string;
  source: 'live' | 'test' | 'schedule';
  durationMs: number;
  tokensEst: number | null;
  agentId: string | null;
  ts: number;
}
