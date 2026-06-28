import crypto from 'node:crypto';
import type { CallResult, Connector, HealthResult, SourceObject, ToolDef } from './types.js';
import { textResult } from './types.js';

/**
 * Google Analytics (GA4) connector — talks to the Admin & Data REST APIs the
 * same way google-analytics-mcp does, but as a first-class source (no process
 * spawning). Auth is a service-account key (stored encrypted as a Secret and
 * passed in resolved as `sa`): we sign a JWT (RS256) and exchange it for a
 * read-only access token.
 */
export interface GaConfig {
  /** Service-account JSON (resolved from `${secret.NAME}`). */
  sa: string;
  /** GCP project id for API quota/billing (sets `x-goog-user-project`). */
  projectId?: string;
  /** Lock the source to ONE GA4 property: when set, every call is forced to this
   *  property (the agent's `property` arg is ignored) and account discovery is
   *  hidden — so the agent can't reach any other property the SA can see. */
  propertyId?: string;
}

const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const ADMIN = 'https://analyticsadmin.googleapis.com/v1beta';
const DATA = 'https://analyticsdata.googleapis.com/v1beta';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
  project_id?: string;
}

// access tokens are reused across short-lived connector instances
const tokenCache = new Map<string, { token: string; exp: number }>();

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

function prop(p: string): string {
  const v = p.trim();
  return v.startsWith('properties/') ? v : `properties/${v}`;
}

const dimsMetrics = (names: unknown): { name: string }[] =>
  (Array.isArray(names) ? names : String(names ?? '').split(',').map((s) => s.trim()).filter(Boolean)).map((n) => ({ name: String(n) }));

export class GaConnector implements Connector {
  constructor(private readonly cfg: GaConfig) {}

  private sa(): ServiceAccount {
    let sa: ServiceAccount;
    try {
      sa = JSON.parse(this.cfg.sa);
    } catch {
      throw new Error('Invalid service-account JSON (set GA_SA_JSON secret to the full key file contents)');
    }
    if (!sa.client_email || !sa.private_key) throw new Error('Service-account JSON missing client_email / private_key');
    return sa;
  }

  private async token(): Promise<string> {
    const sa = this.sa();
    const cached = tokenCache.get(sa.client_email);
    if (cached && cached.exp > Date.now() + 30_000) return cached.token;

    const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: tokenUri, exp: now + 3600, iat: now }));
    const signingInput = `${header}.${claim}`;
    const sig = crypto.createSign('RSA-SHA256').update(signingInput).sign(sa.private_key);
    const jwt = `${signingInput}.${b64url(sig)}`;

    const res = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    });
    const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) throw new Error(`Token exchange failed: ${body.error_description || body.error || res.status}`);
    tokenCache.set(sa.client_email, { token: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000 });
    return body.access_token;
  }

  private async call(method: 'GET' | 'POST', url: string, body?: unknown): Promise<CallResult> {
    const token = await this.token();
    // Only force a quota project when explicitly set — it requires the service
    // account to hold serviceusage.serviceUsageConsumer on that project. Omitted,
    // Google bills quota to the service account's own project (no extra grant).
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(this.cfg.projectId ? { 'x-goog-user-project': this.cfg.projectId } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return textResult(text, !res.ok);
  }

  private propertyOf(args: Record<string, unknown>): string {
    // locked source → always the configured property (ignore the agent's arg)
    const p = this.cfg.propertyId || (args.property as string);
    if (!p) throw new Error('Missing `property` (GA4 property id)');
    return prop(p);
  }

  async listTools(): Promise<ToolDef[]> {
    const locked = !!this.cfg.propertyId;
    // locked: drop the `property` arg entirely; unlocked: agent supplies it
    const property = { type: 'string', description: 'GA4 property id (numeric, or properties/123)' };
    const propProp = locked ? {} : { property };
    const req = (...keys: string[]) => (locked ? keys.filter((k) => k !== 'property') : keys);
    const tools: ToolDef[] = [];

    // account discovery lists ALL properties the SA can see — hide it when locked
    if (!locked) {
      tools.push({ name: 'get_account_summaries', description: 'List GA accounts and their GA4 properties.', inputSchema: { type: 'object', properties: {} } });
    }

    tools.push(
      { name: 'get_property_details', description: 'Details of the GA4 property.', inputSchema: { type: 'object', required: req('property'), properties: { ...propProp } } },
      { name: 'list_google_ads_links', description: 'Google Ads links for the property.', inputSchema: { type: 'object', required: req('property'), properties: { ...propProp } } },
      { name: 'get_custom_dimensions_and_metrics', description: 'Property metadata: available dimensions and metrics.', inputSchema: { type: 'object', required: req('property'), properties: { ...propProp } } },
      {
        name: 'run_report',
        description: 'Run a GA4 core report.',
        inputSchema: {
          type: 'object',
          required: req('property', 'dimensions', 'metrics'),
          properties: {
            ...propProp,
            dimensions: { type: 'array', items: { type: 'string' }, description: 'e.g. date, country, sessionDefaultChannelGroup' },
            metrics: { type: 'array', items: { type: 'string' }, description: 'e.g. activeUsers, sessions, screenPageViews' },
            startDate: { type: 'string', description: 'e.g. 7daysAgo, 2024-01-01 (default 7daysAgo)' },
            endDate: { type: 'string', description: 'e.g. today, yesterday (default today)' },
            limit: { type: 'integer', description: 'Max rows (default 100)' },
          },
        },
      },
      {
        name: 'run_realtime_report',
        description: 'Run a GA4 realtime report (last 30 min).',
        inputSchema: {
          type: 'object',
          required: req('property', 'metrics'),
          properties: {
            ...propProp,
            dimensions: { type: 'array', items: { type: 'string' } },
            metrics: { type: 'array', items: { type: 'string' }, description: 'e.g. activeUsers' },
            limit: { type: 'integer' },
          },
        },
      },
    );

    // All GA tools are read-only analytics reads — attach curated discovery metadata.
    const ro = {
      readOnly: true,
      dangerous: false,
      permissions: ['ga4.read'],
      recommendedUse: { safe_for_automation: true, requires_user_confirmation: false },
    };
    const exProp = locked ? {} : { property: 'properties/123' };

    // Curated output schemas so agents (and the UI) know the GA4 response shape.
    const valueArr = { type: 'array', items: { type: 'object', properties: { value: { type: 'string' } } } };
    const reportOut = {
      type: 'object',
      properties: {
        dimensionHeaders: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } },
        metricHeaders: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' } } } },
        rows: { type: 'array', items: { type: 'object', properties: { dimensionValues: valueArr, metricValues: valueArr } } },
        rowCount: { type: 'number' },
      },
    };
    const propItem = { type: 'object', properties: { property: { type: 'string' }, displayName: { type: 'string' }, propertyType: { type: 'string' } } };
    const accountSummariesOut = {
      type: 'object',
      properties: {
        accountSummaries: {
          type: 'array',
          items: { type: 'object', properties: { account: { type: 'string' }, displayName: { type: 'string' }, propertySummaries: { type: 'array', items: propItem } } },
        },
      },
    };
    const dimItem = { type: 'object', properties: { apiName: { type: 'string' }, uiName: { type: 'string' }, category: { type: 'string' } } };
    const metadataOut = {
      type: 'object',
      properties: {
        dimensions: { type: 'array', items: dimItem },
        metrics: { type: 'array', items: { type: 'object', properties: { apiName: { type: 'string' }, uiName: { type: 'string' }, type: { type: 'string' } } } },
      },
    };
    const propertyOut = {
      type: 'object',
      properties: { name: { type: 'string' }, displayName: { type: 'string' }, timeZone: { type: 'string' }, currencyCode: { type: 'string' }, createTime: { type: 'string' } },
    };
    const adsLinksOut = {
      type: 'object',
      properties: {
        googleAdsLinks: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, customerId: { type: 'string' } } } },
      },
    };
    const outputByName: Record<string, Record<string, unknown>> = {
      run_report: reportOut,
      run_realtime_report: reportOut,
      get_account_summaries: accountSummariesOut,
      get_custom_dimensions_and_metrics: metadataOut,
      get_property_details: propertyOut,
      list_google_ads_links: adsLinksOut,
    };

    const examplesByName: Record<string, ToolDef['examples']> = {
      run_report: [
        {
          description: '7d active users & sessions by date',
          input: { ...exProp, dimensions: ['date'], metrics: ['activeUsers', 'sessions'], startDate: '7daysAgo', endDate: 'today' },
        },
        {
          description: 'Top countries by users, last 28 days',
          input: { ...exProp, dimensions: ['country'], metrics: ['activeUsers'], startDate: '28daysAgo', endDate: 'today', limit: 10 },
        },
      ],
      run_realtime_report: [{ description: 'Active users right now', input: { ...exProp, metrics: ['activeUsers'] } }],
      get_property_details: [{ description: 'Property details', input: { ...exProp } }],
    };
    return tools.map((t) => ({
      ...ro,
      ...t,
      ...(outputByName[t.name] ? { outputSchema: outputByName[t.name] } : {}),
      ...(examplesByName[t.name] ? { examples: examplesByName[t.name] } : {}),
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallResult> {
    try {
      switch (name) {
        case 'get_account_summaries':
          return this.call('GET', `${ADMIN}/accountSummaries`);
        case 'get_property_details':
          return this.call('GET', `${ADMIN}/${this.propertyOf(args)}`);
        case 'list_google_ads_links':
          return this.call('GET', `${ADMIN}/${this.propertyOf(args)}/googleAdsLinks`);
        case 'get_custom_dimensions_and_metrics':
          return this.call('GET', `${DATA}/${this.propertyOf(args)}/metadata`);
        case 'run_report':
          return this.call('POST', `${DATA}/${this.propertyOf(args)}:runReport`, {
            dimensions: dimsMetrics(args.dimensions),
            metrics: dimsMetrics(args.metrics),
            dateRanges: [{ startDate: String(args.startDate ?? '7daysAgo'), endDate: String(args.endDate ?? 'today') }],
            limit: args.limit != null ? Number(args.limit) : 100,
          });
        case 'run_realtime_report':
          return this.call('POST', `${DATA}/${this.propertyOf(args)}:runRealtimeReport`, {
            ...(args.dimensions ? { dimensions: dimsMetrics(args.dimensions) } : {}),
            metrics: dimsMetrics(args.metrics),
            ...(args.limit != null ? { limit: Number(args.limit) } : {}),
          });
        default:
          return textResult(`Unknown GA tool: ${name}`, true);
      }
    } catch (e) {
      return textResult(e instanceof Error ? e.message : String(e), true);
    }
  }

  async health(): Promise<HealthResult> {
    try {
      const r = await this.call('GET', `${ADMIN}/accountSummaries`);
      if (r.isError) return { ok: false, message: r.content[0]?.text?.slice(0, 300) ?? 'request failed' };
      return { ok: true, message: 'authenticated' };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  /** GA4 properties the service account can see (filtered to the locked one if set). */
  async listObjects(): Promise<SourceObject[]> {
    const r = await this.call('GET', `${ADMIN}/accountSummaries`);
    if (r.isError) return [];
    let data: { accountSummaries?: Array<{ displayName?: string; propertySummaries?: Array<{ property?: string; displayName?: string }> }> };
    try {
      data = JSON.parse(r.content[0]?.text ?? '{}');
    } catch {
      return [];
    }
    const locked = this.cfg.propertyId ? prop(this.cfg.propertyId) : null;
    const out: SourceObject[] = [];
    for (const acc of data.accountSummaries ?? []) {
      for (const p of acc.propertySummaries ?? []) {
        if (!p.property) continue;
        if (locked && prop(p.property) !== locked) continue;
        out.push({ id: p.property, name: p.displayName ?? p.property, type: 'property', product_hint: acc.displayName ?? null });
      }
    }
    return out;
  }
}
