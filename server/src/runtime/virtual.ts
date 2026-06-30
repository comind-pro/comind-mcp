import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { sql } from 'drizzle-orm';
import { Agent, fetch as undiciFetch } from 'undici';
import { config } from '../config.js';
import type { CallResult } from '../connectors/types.js';
import { textResult } from '../connectors/types.js';
import { db } from '../db/client.js';
import { rateLimits } from '../db/schema.js';
import { injectSecrets, loadSecretMap } from '../secrets/loader.js';

/** True for loopback / private / link-local / unique-local / reserved addresses
 *  that an outbound call must never reach (SSRF guard). Covers IPv4 + IPv6. */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed → block
    const [a, b] = p;
    return (
      a === 0 || // 0.0.0.0/8
      a === 10 || // 10/8
      a === 127 || // loopback
      (a === 169 && b === 254) || // link-local incl. 169.254.169.254 metadata
      (a === 172 && b >= 16 && b <= 31) || // 172.16/12
      (a === 192 && b === 168) || // 192.168/16
      (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
      a >= 224 // multicast/reserved
    );
  }
  const lo = ip.toLowerCase();
  if (lo === '::1' || lo === '::') return true; // loopback / unspecified
  if (lo.startsWith('fc') || lo.startsWith('fd')) return true; // fc00::/7 unique-local
  if (lo.startsWith('fe80') || lo.startsWith('fe9') || lo.startsWith('fea') || lo.startsWith('feb')) return true; // fe80::/10 link-local
  if (lo.startsWith('::ffff:')) return isPrivateIp(lo.slice(7)); // IPv4-mapped
  return false;
}

function hostAllowed(host: string): boolean {
  const list = config.virtualHostAllowlist;
  if (!list.length) return false; // no allowlist configured
  const h = host.toLowerCase();
  return list.some((a) => h === a || h.endsWith(`.${a}`));
}

/** Hosts that ARE this server — virtual tools must never call back into us
 *  (control-plane, gateway, amplification, recursion). Never allowlist-bypassable. */
function selfHosts(): Set<string> {
  const hosts = new Set<string>(['localhost', config.host.toLowerCase()]);
  try {
    hosts.add(new URL(config.publicBaseUrl).hostname.toLowerCase());
  } catch {
    /* ignore */
  }
  return hosts;
}

/** Pre-flight URL guard: scheme, self-host, allowlist, and literal private IPs.
 *  Hostname → IP validation happens at CONNECT time (safeLookup), so it isn't
 *  resolved again here — that closes the rebinding gap AND avoids a double lookup.
 *  Throws on block. (Not async, but kept Promise-returning for call-site symmetry.) */
export function assertSafeUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Blocked URL scheme: ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  // Never callable: this server itself (not bypassable via allowlist).
  if (selfHosts().has(host.toLowerCase())) throw new Error('Blocked: cannot call this server');
  if (hostAllowed(host)) return; // explicit opt-in for trusted internal hosts
  // Literal private IPs are rejected up-front for a clean error; hostnames are
  // validated at connect time by safeLookup (rebinding-safe, no extra resolve).
  if (isIP(host) && isPrivateIp(host)) throw new Error(`Blocked private address: ${host}`);
}

/** Stored request template for an executable virtual tool. */
export interface VirtualRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  /** JSON body (templated); sent for non-GET when present. */
  body?: unknown;
}

/** Wrap a static descriptive response: a plain string is returned as raw text,
 *  anything else as JSON text + structuredContent. */
export function staticResult(value: unknown): CallResult {
  if (typeof value === 'string') return { content: [{ type: 'text', text: value }] };
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

/** Replace ${args.NAME} placeholders with the call's argument values. */
export function interpArgs(value: string, args: Record<string, unknown>): string {
  return value.replace(/\$\{args\.([A-Za-z0-9_.-]+)\}/g, (_m, n) => {
    const v = args[n];
    return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

/** DNS resolver used at CONNECT time: validates the address we actually connect
 *  to (closes the resolve-then-fetch rebinding gap). Allowlisted hosts bypass. */
export function safeLookup(
  hostname: string,
  opts: { all?: boolean } | undefined,
  cb: (err: Error | null, address?: string | { address: string; family: number }[], family?: number) => void,
): void {
  void (async () => {
    try {
      const addrs = await dns.lookup(hostname, { all: true });
      if (!addrs.length) throw new Error(`Cannot resolve host: ${hostname}`);
      if (!hostAllowed(hostname)) {
        for (const a of addrs)
          if (isPrivateIp(a.address)) throw new Error(`Blocked: ${hostname} → private ${a.address}`);
      }
      // undici's connector requests all addresses (opts.all); honor both contracts.
      if (opts?.all) cb(null, addrs);
      else cb(null, addrs[0].address, addrs[0].family);
    } catch (e) {
      cb(e as Error);
    }
  })();
}

// One shared dispatcher: pins the connected IP via safeLookup, no auto-redirect,
// bounded connect timeout. Reused across calls.
const pinnedAgent = new Agent({
  connect: { lookup: safeLookup as never, timeout: 10_000 },
  maxRedirections: 0,
});

// Per-owner sliding-window rate limit (in-memory; per process).
const rlWindow = new Map<string, number[]>();
export function rateLimited(ownerId: string, now: number): boolean {
  const max = config.virtualRateLimitPerMin;
  if (!max || max <= 0) return false;
  const recent = (rlWindow.get(ownerId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= max) {
    rlWindow.set(ownerId, recent);
    return true;
  }
  recent.push(now);
  rlWindow.set(ownerId, recent);
  return false;
}

/** Shared fixed-window limiter (Postgres): atomic upsert+increment for the
 *  current minute bucket. Returns true when the owner is over the cap. */
async function rateLimitedPg(ownerId: string, now: number): Promise<boolean> {
  const max = config.virtualRateLimitPerMin;
  if (!max || max <= 0) return false;
  const bucket = Math.floor(now / 60_000);
  const [row] = await db
    .insert(rateLimits)
    .values({ key: ownerId, bucket, count: 1 })
    .onConflictDoUpdate({ target: [rateLimits.key, rateLimits.bucket], set: { count: sql`${rateLimits.count} + 1` } })
    .returning({ count: rateLimits.count });
  return (row?.count ?? 1) > max;
}

/** Choose the configured limiter (memory per-process, or pg shared). */
async function overRateLimit(ownerId: string): Promise<boolean> {
  const now = Date.now();
  return config.virtualRateLimitStore === 'pg' ? rateLimitedPg(ownerId, now) : rateLimited(ownerId, now);
}

/** Read a response body up to a byte cap, flagging truncation. */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: '', truncated: false };
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > max) {
      parts.push(value.subarray(0, max - total));
      truncated = true;
      await reader.cancel();
      break;
    }
    parts.push(value);
    total += value.length;
  }
  return { text: Buffer.concat(parts.map((p) => Buffer.from(p))).toString('utf8'), truncated };
}

/** Reject header names/values containing CR/LF (header-injection guard). */
export function sanitizeHeaders(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const val = String(v);
    if (/[\r\n]/.test(k) || /[\r\n]/.test(val)) throw new Error(`Illegal CR/LF in header "${k}"`);
    out[k] = val;
  }
  return out;
}

/**
 * Execute a virtual tool: render the stored request template (args first, then
 * secrets) and perform the HTTP call. Read-only safety is advisory (declared via
 * tool metadata); the executor performs exactly the configured method.
 */
export async function runVirtual(
  request: Record<string, unknown>,
  args: Record<string, unknown>,
  ownerId: string,
): Promise<CallResult> {
  const req = request as unknown as VirtualRequest;
  if (!req?.url || !req?.method) return textResult('Virtual tool request is missing method/url.', true);

  if (await overRateLimit(ownerId)) {
    return textResult(`Rate limit exceeded (${config.virtualRateLimitPerMin}/min for virtual tools).`, true);
  }

  const secretMap = await loadSecretMap(ownerId);
  const render = <T>(v: T): T => injectSecrets(deepInterp(v, args), secretMap);

  let url: URL;
  let headers: Record<string, string>;
  try {
    url = new URL(render(req.url));
    for (const [k, v] of Object.entries(render(req.query ?? {}))) url.searchParams.set(k, String(v));
    assertSafeUrl(url.toString()); // pre-flight SSRF guard (connect-time validates the IP)
    headers = sanitizeHeaders(render(req.headers ?? {}));
  } catch (e) {
    return textResult(e instanceof Error ? e.message : String(e), true);
  }

  const hasBody = req.body !== undefined && req.method !== 'GET';
  if (hasBody && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
    headers['content-type'] = 'application/json';
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.virtualTimeoutMs);
  try {
    const res = await undiciFetch(url, {
      method: req.method,
      headers,
      body: hasBody ? JSON.stringify(render(req.body)) : undefined,
      signal: ctrl.signal,
      redirect: 'manual', // no auto-follow (a redirect could bounce to a private host)
      dispatcher: pinnedAgent, // connect-time IP validation (rebinding-safe)
    });
    const { text, truncated } = await readCapped(
      res.body as ReadableStream<Uint8Array> | null,
      config.virtualMaxResponseBytes,
    );
    const out = truncated ? `${text}\n…[truncated at ${config.virtualMaxResponseBytes} bytes]` : text;
    return textResult(out, !(res.status >= 200 && res.status < 300));
  } catch (e) {
    const msg =
      (e as Error)?.name === 'AbortError'
        ? `Request timed out after ${config.virtualTimeoutMs}ms`
        : e instanceof Error
          ? e.message
          : String(e);
    return textResult(msg, true);
  } finally {
    clearTimeout(timer);
  }
}

/** Deep ${args.x} interpolation across strings in a value tree. */
export function deepInterp<T>(value: T, args: Record<string, unknown>): T {
  if (typeof value === 'string') return interpArgs(value, args) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => deepInterp(v, args)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepInterp(v, args);
    return out as T;
  }
  return value;
}
