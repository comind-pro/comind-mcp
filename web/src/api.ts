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

export interface Source {
  id: string;
  name: string;
  kind: 'mcp' | 'openapi' | 'http' | 'imap' | 'sql';
  config: Record<string, unknown>;
  status: string;
  statusMessage: string | null;
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
}
export interface Group {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  schedulingEnabled: boolean;
}
export interface AgentGroupGrant {
  id: string;
  name: string;
  slug: string;
  endpoint: string;
}
export interface Agent {
  id: string;
  name: string;
  apiKeyPrefix: string;
  groups?: AgentGroupGrant[];
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
