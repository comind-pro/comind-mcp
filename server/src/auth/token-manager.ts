import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { oauthTokens } from '../db/schema.js';
import { newId } from '../lib/id.js';
import { decrypt, encrypt } from '../secrets/vault.js';
import type { AuthConfig } from './config.js';

export interface AuthHeader {
  name: string;
  value: string;
}

interface Cached {
  token: string;
  exp: number; // epoch ms; 0 = never expires
}

// In-memory token cache for client_credentials / refresh / token_request.
const cache = new Map<string, Cached>();
const SKEW_MS = 30_000;

function pathGet(obj: unknown, path: string): unknown {
  return path
    .replace(/^\$\.?/, '')
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((acc, k) => (acc == null ? acc : (acc as Record<string, unknown>)[k]), obj);
}

async function form(url: string, params: Record<string, string>, basic?: { id: string; secret: string }) {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (basic) headers.Authorization = `Basic ${Buffer.from(`${basic.id}:${basic.secret}`).toString('base64')}`;
  const res = await fetch(url, { method: 'POST', headers, body: new URLSearchParams(params).toString() });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token endpoint ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as { access_token?: string; expires_in?: number; [k: string]: unknown };
}

async function clientCredentials(auth: Extract<AuthConfig, { type: 'oauth2_client_credentials' }>) {
  const params: Record<string, string> = { grant_type: 'client_credentials' };
  if (auth.scope) params.scope = auth.scope;
  const basic = auth.authStyle === 'basic';
  if (!basic) {
    params.client_id = auth.clientId;
    params.client_secret = auth.clientSecret;
  }
  const r = await form(auth.tokenUrl, params, basic ? { id: auth.clientId, secret: auth.clientSecret } : undefined);
  if (!r.access_token) throw new Error('No access_token in response');
  return { token: r.access_token, ttl: r.expires_in ?? 3600 };
}

async function refresh(auth: Extract<AuthConfig, { type: 'oauth2_refresh' }>) {
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: auth.refreshToken,
    client_id: auth.clientId,
  };
  if (auth.clientSecret) params.client_secret = auth.clientSecret;
  if (auth.scope) params.scope = auth.scope;
  const r = await form(auth.tokenUrl, params);
  if (!r.access_token) throw new Error('No access_token in response');
  return { token: r.access_token, ttl: r.expires_in ?? 3600 };
}

async function tokenRequest(auth: Extract<AuthConfig, { type: 'token_request' }>) {
  const method = auth.method ?? 'POST';
  const headers: Record<string, string> = { ...(auth.headers ?? {}) };
  let body: string | undefined;
  if (method === 'POST') {
    headers['content-type'] = headers['content-type'] ?? 'application/json';
    body = JSON.stringify(auth.body ?? {});
  }
  const res = await fetch(auth.tokenUrl, { method, headers, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`Login endpoint ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  const token = pathGet(json, auth.tokenPath);
  if (typeof token !== 'string') throw new Error(`No token at ${auth.tokenPath}`);
  let ttl = auth.ttlSec ?? 3600;
  if (auth.expiresPath) {
    const e = pathGet(json, auth.expiresPath);
    if (typeof e === 'number') ttl = e;
  }
  return { token, ttl };
}

/** authorization_code: read stored tokens, refresh access via refresh_token when expired. */
async function authorizationCode(
  sourceId: string,
  auth: Extract<AuthConfig, { type: 'oauth2_authorization_code' }>,
): Promise<string> {
  const [row] = await db.select().from(oauthTokens).where(eq(oauthTokens.sourceId, sourceId));
  if (!row) throw new Error('Source not connected — run OAuth start to authorize');

  const valid = !row.expiresAt || row.expiresAt.getTime() - SKEW_MS > Date.now();
  if (valid) return decrypt(row.accessEnc);

  if (!row.refreshEnc) throw new Error('Access token expired and no refresh token — re-authorize');
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: decrypt(row.refreshEnc),
    client_id: auth.clientId,
  };
  if (auth.clientSecret) params.client_secret = auth.clientSecret;
  const r = await form(auth.tokenUrl, params);
  if (!r.access_token) throw new Error('Refresh failed: no access_token');
  await saveTokens(sourceId, r.access_token, (r.refresh_token as string) ?? decrypt(row.refreshEnc), r.expires_in ?? 3600);
  return r.access_token;
}

/** Persist authorization_code tokens (encrypted). Used by the OAuth callback + refresh. */
export async function saveTokens(
  sourceId: string,
  access: string,
  refreshToken: string | null,
  ttlSec: number,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlSec * 1000);
  const [existing] = await db.select().from(oauthTokens).where(eq(oauthTokens.sourceId, sourceId));
  const values = {
    accessEnc: encrypt(access),
    refreshEnc: refreshToken ? encrypt(refreshToken) : existing?.refreshEnc ?? null,
    expiresAt,
  };
  if (existing) await db.update(oauthTokens).set(values).where(eq(oauthTokens.sourceId, sourceId));
  else await db.insert(oauthTokens).values({ id: newId(), sourceId, createdAt: new Date(), ...values });
}

/** Resolve the auth header to inject for a source's outgoing calls. */
export async function getAuthHeader(sourceId: string, auth: AuthConfig): Promise<AuthHeader> {
  // Basic auth — no token fetch, just base64(user:pass).
  if (auth.type === 'basic') {
    const value = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
    return { name: auth.header ?? 'Authorization', value };
  }

  if (auth.type === 'oauth2_authorization_code') {
    const token = await authorizationCode(sourceId, auth);
    return { name: 'Authorization', value: `Bearer ${token}` };
  }

  const key = `${sourceId}:${auth.type}`;
  const hit = cache.get(key);
  if (hit && (hit.exp === 0 || hit.exp - SKEW_MS > Date.now())) {
    return headerFor(auth, hit.token);
  }

  let res: { token: string; ttl: number };
  if (auth.type === 'oauth2_client_credentials') res = await clientCredentials(auth);
  else if (auth.type === 'oauth2_refresh') res = await refresh(auth);
  else if (auth.type === 'token_request') res = await tokenRequest(auth);
  else throw new Error(`Auth type ${auth.type} is not header-based`);

  cache.set(key, { token: res.token, exp: Date.now() + res.ttl * 1000 });
  return headerFor(auth, res.token);
}

function headerFor(auth: AuthConfig, token: string): AuthHeader {
  if (auth.type === 'token_request') {
    return { name: auth.injectHeader ?? 'Authorization', value: `${auth.injectPrefix ?? 'Bearer '}${token}` };
  }
  return { name: 'Authorization', value: `Bearer ${token}` };
}

export function clearTokenCache(sourceId?: string): void {
  if (!sourceId) return cache.clear();
  for (const k of cache.keys()) if (k.startsWith(`${sourceId}:`)) cache.delete(k);
}
