import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client.js';
import { agentKeys } from '../db/schema.js';
import { hashKey } from '../lib/crypto.js';

/**
 * Temporary request-capture instrument: records every inbound request to the
 * MCP / OAuth / discovery paths into an in-memory ring so we can see EXACTLY
 * what a remote MCP client (Claude.ai's connection probe + OAuth flow) sends —
 * past the truncated platform logs. Read it at GET /debug/requests, authed with
 * a valid agent key. Sensitive fields are redacted. Remove once diagnosed.
 */
interface Captured {
  t: number;
  method: string;
  url: string;
  status: number;
  origin?: string;
  ua?: string;
  accept?: string;
  ct?: string;
  hasAuth: boolean;
  body?: unknown;
}

const RING: Captured[] = [];
const CAP = 300;
const WATCH = /^\/(a\/mcp|g\/[^/]+\/mcp|oauth\/|\.well-known\/)/;
const SECRET_KEYS = new Set(['code', 'code_verifier', 'refresh_token', 'access_token', 'agent_key', 'client_secret']);

function redact(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.has(k) && typeof v === 'string' ? `<redacted:${v.length}>` : v;
  }
  return out;
}

export function registerCapture(app: FastifyInstance): void {
  app.addHook('onResponse', async (req, reply) => {
    const p = req.url.split('?')[0];
    if (p === '/oauth/_capture' || !WATCH.test(p)) return;
    const h = req.headers;
    RING.push({
      t: Date.now(),
      method: req.method,
      url: req.url,
      status: reply.statusCode,
      origin: h.origin as string | undefined,
      ua: (h['user-agent'] as string | undefined)?.slice(0, 60),
      accept: h.accept as string | undefined,
      ct: h['content-type'] as string | undefined,
      hasAuth: typeof h.authorization === 'string' && h.authorization.length > 0,
      body: redact(req.body),
    });
    if (RING.length > CAP) RING.splice(0, RING.length - CAP);
  });

  // Mounted under /oauth so DO's ingress routes it to the server component
  // (a bare /debug prefix falls through to the static web app).
  app.get('/oauth/_capture', async (req, reply) => {
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return reply.code(401).send({ error: 'agent key required' });
    const [key] = await db
      .select({ id: agentKeys.id })
      .from(agentKeys)
      .where(and(eq(agentKeys.hash, hashKey(token)), eq(agentKeys.archived, false)));
    if (!key) return reply.code(403).send({ error: 'invalid agent key' });
    return { count: RING.length, requests: [...RING].reverse() };
  });
}
