import type { CallResult, Connector, HealthResult, ToolDef } from './types.js';
import { textResult } from './types.js';

export interface HttpEndpoint {
  name: string;
  method: string;
  /** Path template; `{param}` placeholders are filled from args. */
  path: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface HttpConfig {
  baseUrl: string;
  headers?: Record<string, string>;
  /** Optional GET path used by health checks. */
  healthPath?: string;
  endpoints: HttpEndpoint[];
}

/** Internal service connector: a hand-declared set of HTTP endpoints as tools. */
export class HttpConnector implements Connector {
  constructor(private readonly cfg: HttpConfig) {}

  async listTools(): Promise<ToolDef[]> {
    return this.cfg.endpoints.map((e) => ({
      name: e.name,
      description: e.description,
      inputSchema: e.inputSchema ?? { type: 'object', properties: {} },
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallResult> {
    const ep = this.cfg.endpoints.find((e) => e.name === name);
    if (!ep) return textResult(`Unknown endpoint: ${name}`, true);

    let path = ep.path;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args ?? {})) {
      if (path.includes(`{${k}}`)) path = path.replace(`{${k}}`, encodeURIComponent(String(v)));
      else body[k] = v;
    }

    const method = ep.method.toUpperCase();
    const hasBody = method !== 'GET' && Object.keys(body).length > 0;
    const headers: Record<string, string> = { ...(this.cfg.headers ?? {}) };
    if (hasBody) headers['content-type'] = headers['content-type'] ?? 'application/json';

    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers,
      body: hasBody ? JSON.stringify(body) : undefined,
    });
    return textResult(await res.text(), !res.ok);
  }

  async health(): Promise<HealthResult> {
    try {
      const url = `${this.cfg.baseUrl.replace(/\/$/, '')}${this.cfg.healthPath ?? '/'}`;
      const res = await fetch(url, { headers: this.cfg.headers });
      return { ok: res.ok, message: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
