import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { agentGroups, agentKeys, agents, oauthAccessTokens, oauthAuthCodes, oauthClients } from '../db/schema.js';
import { hashKey } from '../lib/crypto.js';
import { newId } from '../lib/id.js';

/**
 * Inbound OAuth 2.0 Authorization Server — lets MCP clients that require OAuth
 * (ChatGPT, Claude.ai connectors) connect to a V-MCP endpoint.
 *
 * Flow: client discovers metadata → DCR (/oauth/register) → /oauth/authorize
 * (HTML consent: user pastes their agent key) → /oauth/token (PKCE). The issued
 * access token resolves to the pasted agent + the group from the resource URL,
 * so the agent's existing grants decide which tools are reachable.
 */
const BASE = config.publicBaseUrl;
const CODE_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_S = 30 * 24 * 60 * 60; // 30 days

const sha256b64url = (s: string) => createHash('sha256').update(s).digest('base64url');
const randomToken = () => randomBytes(32).toString('base64url');
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Extract the V-MCP group id from a resource URL like `<base>/g/<id>/mcp`. */
function groupIdFromResource(resource: string | undefined): string | null {
  if (!resource) return null;
  const m = /\/g\/([^/]+)\/mcp\/?$/.exec(resource);
  return m ? m[1] : null;
}

/** Agent-wide endpoint `<base>/a/mcp` — token covers all the agent's groups. */
function isAgentResource(resource: string | undefined): boolean {
  return !!resource && /\/a\/mcp\/?$/.test(resource);
}

export async function oauthProviderRoutes(app: FastifyInstance): Promise<void> {
  // ── Discovery metadata ──────────────────────────────────────────────
  app.get('/.well-known/oauth-authorization-server', async () => ({
    issuer: BASE,
    authorization_endpoint: `${BASE}/oauth/authorize`,
    token_endpoint: `${BASE}/oauth/token`,
    registration_endpoint: `${BASE}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  }));

  // Root metadata advertises the base; per-path metadata (RFC 9728) echoes the
  // actual endpoint as the resource so the client carries it into /authorize.
  app.get('/.well-known/oauth-protected-resource', async () => ({
    resource: BASE,
    authorization_servers: [BASE],
  }));
  app.get('/.well-known/oauth-protected-resource/*', async (req) => {
    const star = (req.params as Record<string, string>)['*'] || '';
    return { resource: `${BASE}/${star}`.replace(/\/$/, ''), authorization_servers: [BASE] };
  });

  // ── Dynamic Client Registration (RFC 7591) ──────────────────────────
  app.post('/oauth/register', async (req, reply) => {
    const body = (req.body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (redirectUris.length === 0) {
      return reply.code(400).send({ error: 'invalid_redirect_uri', error_description: 'redirect_uris required' });
    }
    const clientId = `cmc_${randomBytes(12).toString('base64url')}`;
    await db.insert(oauthClients).values({
      id: newId(),
      clientId,
      clientName: typeof body.client_name === 'string' ? body.client_name : null,
      redirectUris,
      createdAt: new Date(),
    });
    return reply.code(201).send({
      client_id: clientId,
      client_name: body.client_name ?? undefined,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  // ── Authorization (consent page: paste agent key) ───────────────────
  app.get('/oauth/authorize', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const err = await validateAuthorizeParams(q);
    if (err) return reply.code(400).type('text/html').send(errorPage(err));
    reply.type('text/html').send(consentPage(q, null));
  });

  app.post('/oauth/authorize', async (req, reply) => {
    const b = req.body as Record<string, string | undefined>;
    const err = await validateAuthorizeParams(b);
    if (err) return reply.code(400).type('text/html').send(errorPage(err));

    const groupId = groupIdFromResource(b.resource); // null = agent-wide (/a/mcp)
    const agentKey = (b.agent_key ?? '').trim();
    const [keyRow] = await db
      .select({ agentId: agentKeys.agentId })
      .from(agentKeys)
      .where(and(eq(agentKeys.hash, hashKey(agentKey)), eq(agentKeys.archived, false)));
    const agent = keyRow ? (await db.select().from(agents).where(eq(agents.id, keyRow.agentId)))[0] : undefined;
    if (!agent) return reply.code(401).type('text/html').send(consentPage(b, 'Invalid agent key.'));

    // Group-scoped resource: the agent must be granted that group. Agent-wide
    // (/a/mcp): grants are resolved per call, so no check here.
    if (groupId) {
      const [grant] = await db
        .select()
        .from(agentGroups)
        .where(and(eq(agentGroups.agentId, agent.id), eq(agentGroups.groupId, groupId)));
      if (!grant) {
        return reply.code(403).type('text/html').send(consentPage(b, 'This agent has no access to this V-MCP.'));
      }
    }

    const code = randomToken();
    await db.insert(oauthAuthCodes).values({
      id: newId(),
      codeHash: hashKey(code),
      clientId: b.client_id!,
      agentId: agent.id,
      groupId,
      redirectUri: b.redirect_uri!,
      codeChallenge: b.code_challenge!,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
      createdAt: new Date(),
    });

    const url = new URL(b.redirect_uri!);
    url.searchParams.set('code', code);
    if (b.state) url.searchParams.set('state', b.state);
    return reply.redirect(url.toString());
  });

  // ── Token ────────────────────────────────────────────────────────────
  app.post('/oauth/token', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    const grant = b.grant_type;

    if (grant === 'authorization_code') {
      const { code, code_verifier, redirect_uri, client_id } = b;
      if (!code || !code_verifier) return tokenError(reply, 'invalid_request', 'code and code_verifier required');
      const [row] = await db
        .select()
        .from(oauthAuthCodes)
        .where(eq(oauthAuthCodes.codeHash, hashKey(code)));
      if (!row) return tokenError(reply, 'invalid_grant', 'unknown code');
      // single-use: drop immediately
      await db.delete(oauthAuthCodes).where(eq(oauthAuthCodes.id, row.id));
      if (row.expiresAt.getTime() < Date.now()) return tokenError(reply, 'invalid_grant', 'code expired');
      if (client_id && client_id !== row.clientId) return tokenError(reply, 'invalid_grant', 'client mismatch');
      if (redirect_uri && redirect_uri !== row.redirectUri)
        return tokenError(reply, 'invalid_grant', 'redirect_uri mismatch');
      if (sha256b64url(code_verifier) !== row.codeChallenge) return tokenError(reply, 'invalid_grant', 'PKCE failed');

      return reply.send(await issueTokens(row.clientId, row.agentId, row.groupId));
    }

    if (grant === 'refresh_token') {
      const refresh = b.refresh_token;
      if (!refresh) return tokenError(reply, 'invalid_request', 'refresh_token required');
      const [row] = await db
        .select()
        .from(oauthAccessTokens)
        .where(eq(oauthAccessTokens.refreshHash, hashKey(refresh)));
      if (!row) return tokenError(reply, 'invalid_grant', 'unknown refresh_token');
      await db.delete(oauthAccessTokens).where(eq(oauthAccessTokens.id, row.id)); // rotate
      return reply.send(await issueTokens(row.clientId, row.agentId, row.groupId));
    }

    return tokenError(reply, 'unsupported_grant_type', `grant_type ${grant} not supported`);
  });
}

async function validateAuthorizeParams(p: Record<string, string | undefined>): Promise<string | null> {
  if (p.response_type !== 'code') return 'response_type must be "code"';
  if (!p.client_id) return 'client_id required';
  if (!p.redirect_uri) return 'redirect_uri required';
  if (!p.code_challenge || p.code_challenge_method !== 'S256') return 'PKCE S256 required';
  // Accept a group endpoint, the agent-wide endpoint, or the bare base
  // (some clients send the AS base as the resource → treat as agent-wide).
  const bareBase = p.resource === BASE || p.resource === `${BASE}/`;
  if (!groupIdFromResource(p.resource) && !isAgentResource(p.resource) && !bareBase)
    return 'resource must be a V-MCP endpoint (…/g/<id>/mcp or …/a/mcp)';
  const [client] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, p.client_id));
  if (!client) return 'unknown client_id';
  if (!client.redirectUris.includes(p.redirect_uri)) return 'redirect_uri not registered for client';
  return null;
}

async function issueTokens(clientId: string, agentId: string, groupId: string | null) {
  const access = randomToken();
  const refresh = randomToken();
  await db.insert(oauthAccessTokens).values({
    id: newId(),
    tokenHash: hashKey(access),
    refreshHash: hashKey(refresh),
    clientId,
    agentId,
    groupId,
    expiresAt: new Date(Date.now() + TOKEN_TTL_S * 1000),
    createdAt: new Date(),
  });
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: TOKEN_TTL_S,
    refresh_token: refresh,
    scope: 'mcp',
  };
}

function tokenError(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, error: string, desc: string) {
  return reply.code(400).send({ error, error_description: desc });
}

function consentPage(p: Record<string, string | undefined>, error: string | null): string {
  const hidden = [
    'response_type',
    'client_id',
    'redirect_uri',
    'state',
    'code_challenge',
    'code_challenge_method',
    'scope',
    'resource',
  ]
    .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(p[k] ?? '')}">`)
    .join('\n');
  const groupId = groupIdFromResource(p.resource);
  const scopeNote = groupId
    ? `this V-MCP (group <code>${escapeHtml(groupId)}</code>)`
    : `<b>all V-MCPs this agent can reach</b>`;
  return page(`
    <h1>Connect to comind-mcp</h1>
    <p class="muted">An MCP client wants to access your virtual MCP endpoint:</p>
    <p class="code">${escapeHtml(p.resource ?? '')}</p>
    <p class="muted">Paste the <b>agent key</b> — the token will grant access to ${scopeNote}. Create one in the Agents tab.</p>
    ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
    <form method="post" action="/oauth/authorize">
      ${hidden}
      <input class="key" name="agent_key" type="password" placeholder="cmd_..." autocomplete="off" autofocus />
      <button type="submit">Authorize</button>
    </form>
  `);
}

function errorPage(msg: string): string {
  return page(`<h1>Authorization error</h1><p class="err">${escapeHtml(msg)}</p>`);
}

function page(inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>comind-mcp · Authorize</title><style>
:root{--bg:#0f1216;--panel:#181d24;--border:#2a323d;--text:#e6edf3;--muted:#8b98a8;--accent:#4f9cf9;--err:#f85149}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:28px;width:440px;max-width:92vw}
h1{font-size:20px;margin:0 0 12px}p{line-height:1.5;font-size:14px}.muted{color:var(--muted)}
.code{background:#06121f;border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all}
.err{color:var(--err)}code{font-family:ui-monospace,Menlo,monospace;font-size:12px}
.key{width:100%;background:#1f2630;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:10px;font-size:14px;margin:12px 0}
button{width:100%;background:var(--accent);color:#06121f;border:none;border-radius:6px;padding:10px;font-size:14px;font-weight:600;cursor:pointer}
</style></head><body><div class="card">${inner}</div></body></html>`;
}
