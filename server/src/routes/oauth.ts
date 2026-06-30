import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authConfigSchema } from '../auth/config.js';
import { completeMcpOAuth, startMcpOAuth } from '../auth/mcp-oauth.js';
import { saveTokens } from '../auth/token-manager.js';
import { config } from '../config.js';
import { fetchWithTimeout } from '../connectors/fetch.js';
import { db } from '../db/client.js';
import { sources } from '../db/schema.js';
import { resolveSourceConfig } from '../secrets/loader.js';

// state → sourceId for the generic authorization_code flow (mcp_oauth uses state=sourceId).
const pending = new Map<string, { sourceId: string; at: number }>();
const STATE_TTL = 10 * 60 * 1000;

function defaultRedirect(): string {
  return `http://${config.host}:${config.port}/oauth/callback`;
}

async function loadAuth(sourceId: string) {
  const [row] = await db.select().from(sources).where(eq(sources.id, sourceId));
  if (!row) return null;
  const resolved = await resolveSourceConfig(row.config, row.ownerId, row.id);
  if (!resolved.auth) return null;
  return { row, resolved, auth: authConfigSchema.parse(resolved.auth) };
}

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/sources/:id/oauth/start', async (req, reply) => {
    const { id } = req.params as { id: string };
    const owner = (req as { userId?: string }).userId;
    const loaded = await loadAuth(id);
    if (!loaded) return reply.code(400).send({ error: 'source_has_no_oauth' });
    if (loaded.row.ownerId !== owner) return reply.code(404).send({ error: 'not_found' });
    const { auth, resolved } = loaded;

    // MCP-native OAuth: SDK does discovery/DCR/PKCE.
    if (auth.type === 'mcp_oauth') {
      const url = await startMcpOAuth(id, String(resolved.url), { scope: auth.scope, clientId: auth.clientId });
      return url ? { url } : { url: null, message: 'Already connected' };
    }

    // Generic authorization_code.
    if (auth.type === 'oauth2_authorization_code') {
      // Random, unguessable state (CSRF) — the source id lives in `pending`, not the state.
      const state = randomBytes(24).toString('base64url');
      pending.set(state, { sourceId: id, at: Date.now() });
      const redirectUri = auth.redirectUri ?? defaultRedirect();
      const u = new URL(auth.authUrl);
      u.searchParams.set('client_id', auth.clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('response_type', 'code');
      if (auth.scope) u.searchParams.set('scope', auth.scope);
      u.searchParams.set('state', state);
      u.searchParams.set('access_type', 'offline');
      u.searchParams.set('prompt', 'consent');
      return { url: u.toString(), redirectUri };
    }

    return reply.code(400).send({ error: 'auth_type_not_interactive' });
  });

  app.get('/oauth/callback', async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    reply.header('content-type', 'text/html');
    if (!code || !state) return reply.send(html('Missing code/state.'));

    // Generic flow: state is in the pending map.
    const entry = pending.get(state);
    if (entry) {
      if (Date.now() - entry.at > STATE_TTL) return reply.send(html('Expired state.'));
      pending.delete(state);
      const loaded = await loadAuth(entry.sourceId);
      if (loaded?.auth.type !== 'oauth2_authorization_code') return reply.send(html('Invalid source.'));
      return reply.send(await exchangeGeneric(entry.sourceId, loaded.auth, code));
    }

    // MCP-native flow: state === sourceId.
    const loaded = await loadAuth(state);
    if (loaded && loaded.auth.type === 'mcp_oauth') {
      try {
        await completeMcpOAuth(state, String(loaded.resolved.url), code, {
          scope: loaded.auth.scope,
          clientId: loaded.auth.clientId,
        });
        await db.update(sources).set({ status: 'ok', statusMessage: 'OAuth connected' }).where(eq(sources.id, state));
        return reply.send(html('✓ Connected. You can close this tab.'));
      } catch (err) {
        return reply.send(html(`Error: ${err instanceof Error ? err.message : String(err)}`));
      }
    }

    return reply.send(html('Unknown or expired state.'));
  });
}

async function exchangeGeneric(
  sourceId: string,
  auth: Extract<ReturnType<typeof authConfigSchema.parse>, { type: 'oauth2_authorization_code' }>,
  code: string,
): Promise<string> {
  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: auth.redirectUri ?? defaultRedirect(),
    client_id: auth.clientId,
  };
  if (auth.clientSecret) params.client_secret = auth.clientSecret;
  try {
    const res = await fetchWithTimeout(auth.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    const text = await res.text();
    if (!res.ok) return html(`Token exchange failed: ${res.status} ${text.slice(0, 200)}`);
    const j = JSON.parse(text);
    if (!j.access_token) return html('No access_token in response.');
    await saveTokens(sourceId, j.access_token, j.refresh_token ?? null, j.expires_in ?? 3600);
    await db.update(sources).set({ status: 'ok', statusMessage: 'OAuth connected' }).where(eq(sources.id, sourceId));
    return html('✓ Connected. You can close this tab.');
  } catch (err) {
    return html(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function html(msg: string): string {
  return `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#0f1216;color:#e6edf3;padding:40px"><h2>comind-mcp</h2><p>${msg}</p></body>`;
}
