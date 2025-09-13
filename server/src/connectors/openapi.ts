import type { Connector, CallResult, HealthResult, ToolDef } from './types.js';
import { textResult } from './types.js';

export interface OpenApiConfig {
  /** Fetch the spec from here, or pass `spec` inline. */
  specUrl?: string;
  spec?: Record<string, unknown>;
  /** Overrides spec.servers[0].url. */
  baseUrl?: string;
  headers?: Record<string, string>;
}

type ParamLoc = 'path' | 'query' | 'header';

interface Operation {
  name: string;
  description?: string;
  method: string;
  path: string;
  paramLoc: Record<string, ParamLoc>;
  bodyKeys: Set<string>;
  inputSchema: Record<string, unknown>;
}

interface Parsed {
  baseUrl: string;
  ops: Map<string, Operation>;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const specCache = new Map<string, { parsed: Parsed; at: number }>();
const TTL_MS = 60_000;

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'op';
}

/** Shallow local `$ref` resolver (`#/components/...`). */
function deref(spec: any, node: any, seen = new Set<string>()): any {
  if (!node || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string') {
    const ref = node.$ref as string;
    if (seen.has(ref) || !ref.startsWith('#/')) return {};
    seen.add(ref);
    const target = ref
      .slice(2)
      .split('/')
      .reduce((acc: any, k) => (acc ? acc[k] : undefined), spec);
    return deref(spec, target, seen);
  }
  return node;
}

function parse(spec: any, cfgBase?: string): Parsed {
  const baseUrl = cfgBase ?? spec?.servers?.[0]?.url ?? '';
  const ops = new Map<string, Operation>();
  const paths = spec?.paths ?? {};

  for (const [path, pathItem] of Object.entries<any>(paths)) {
    const sharedParams: any[] = pathItem.parameters ?? [];
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;

      const name = sanitize(op.operationId ?? `${method}_${path}`);
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      const paramLoc: Record<string, ParamLoc> = {};
      const bodyKeys = new Set<string>();

      for (const raw of [...sharedParams, ...(op.parameters ?? [])]) {
        const p = deref(spec, raw);
        if (!p?.name || !['path', 'query', 'header'].includes(p.in)) continue;
        properties[p.name] = { ...(deref(spec, p.schema) ?? { type: 'string' }), description: p.description };
        paramLoc[p.name] = p.in;
        if (p.required) required.push(p.name);
      }

      const bodySchema = deref(spec, op.requestBody)?.content?.['application/json']?.schema;
      const body = deref(spec, bodySchema);
      if (body?.type === 'object' && body.properties) {
        for (const [k, v] of Object.entries<any>(body.properties)) {
          properties[k] = deref(spec, v);
          bodyKeys.add(k);
        }
        for (const r of body.required ?? []) required.push(r);
      } else if (body) {
        properties.body = body;
        bodyKeys.add('body');
      }

      ops.set(name, {
        name,
        description: op.summary ?? op.description,
        method,
        path,
        paramLoc,
        bodyKeys,
        inputSchema: { type: 'object', properties, required },
      });
    }
  }
  return { baseUrl, ops };
}

export class OpenApiConnector implements Connector {
  constructor(private readonly cfg: OpenApiConfig) {}

  private async ensure(): Promise<Parsed> {
    const key = this.cfg.specUrl ?? JSON.stringify(this.cfg.spec)?.slice(0, 200) ?? 'inline';
    const cached = specCache.get(key);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.parsed;

    let spec = this.cfg.spec;
    if (!spec && this.cfg.specUrl) {
      const res = await fetch(this.cfg.specUrl, { headers: this.cfg.headers });
      if (!res.ok) throw new Error(`Fetch spec failed: ${res.status} ${res.statusText}`);
      spec = (await res.json()) as Record<string, unknown>;
    }
    if (!spec) throw new Error('OpenAPI source needs `specUrl` or inline `spec`');

    const parsed = parse(spec, this.cfg.baseUrl);
    specCache.set(key, { parsed, at: Date.now() });
    return parsed;
  }

  async listTools(): Promise<ToolDef[]> {
    const { ops } = await this.ensure();
    return [...ops.values()].map((o) => ({
      name: o.name,
      description: o.description,
      inputSchema: o.inputSchema,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallResult> {
    const { baseUrl, ops } = await this.ensure();
    const op = ops.get(name);
    if (!op) return textResult(`Unknown operation: ${name}`, true);

    let path = op.path;
    const query = new URLSearchParams();
    const headers: Record<string, string> = { ...(this.cfg.headers ?? {}) };
    const body: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(args ?? {})) {
      if (v === undefined || v === null) continue;
      const loc = op.paramLoc[k];
      if (loc === 'path') path = path.replace(`{${k}}`, encodeURIComponent(String(v)));
      else if (loc === 'query') query.set(k, String(v));
      else if (loc === 'header') headers[k] = String(v);
      else if (op.bodyKeys.has(k)) body[k] = v;
    }

    const url = `${baseUrl.replace(/\/$/, '')}${path}${query.toString() ? `?${query}` : ''}`;
    const hasBody = op.bodyKeys.size > 0 && op.method !== 'get';
    if (hasBody) headers['content-type'] = headers['content-type'] ?? 'application/json';

    const res = await fetch(url, {
      method: op.method.toUpperCase(),
      headers,
      body: hasBody ? JSON.stringify('body' in body ? body.body : body) : undefined,
    });
    const text = await res.text();
    return textResult(text, !res.ok);
  }

  async health(): Promise<HealthResult> {
    try {
      const { ops } = await this.ensure();
      return { ok: true, message: `${ops.size} operations` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
