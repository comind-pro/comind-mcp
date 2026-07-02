import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { config } from './config.js';
import { pool } from './db/client.js';
import { verifyJwt } from './lib/auth.js';
import { agentRoutes } from './routes/agents.js';
import { authRoutes } from './routes/auth.js';
import { compositeRoutes } from './routes/composite.js';
import { registerCapture } from './routes/debug.js';
import { gatewayRoutes } from './routes/gateway.js';
import { groupRoutes } from './routes/groups.js';
import { oauthRoutes } from './routes/oauth.js';
import { oauthProviderRoutes } from './routes/oauth-provider.js';
import { observabilityRoutes } from './routes/observability.js';
import { scheduleRoutes } from './routes/schedules.js';
import { secretRoutes } from './routes/secrets.js';
import { sourceRoutes } from './routes/sources.js';
import { toolRoutes } from './routes/tools.js';
import { virtualRoutes } from './routes/virtual.js';

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: { level: 'info' } });

  app.register(cors, {
    origin: config.corsOrigins === '*' ? true : config.corsOrigins.split(','),
  });

  // Tolerate empty JSON bodies (import/test/run-now are bodyless POSTs).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body || (body as string).length === 0) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // OAuth endpoints (token/register/consent) speak form-urlencoded.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams((body as string) || '')));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.setErrorHandler((err: { statusCode?: number; message?: string }, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'validation', issues: err.issues });
    }
    app.log.error(err);
    return reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'internal_error' });
  });

  // Auth gate: control-plane routes require a user JWT. Public: health, auth
  // entry, agent gateway (`/g/*` uses agent keys), and the OAuth provider callback.
  const isPublic = (url: string) => {
    const path = url.split('?')[0];
    return (
      path === '/healthz' ||
      path === '/auth/register' ||
      path === '/auth/login' ||
      path === '/oauth/callback' ||
      // Inbound OAuth (we are the Authorization Server): discovery + flow are
      // public; they authenticate via PKCE / the pasted agent key themselves.
      path.startsWith('/.well-known/') ||
      path === '/oauth/register' ||
      path === '/oauth/authorize' ||
      path === '/oauth/token' ||
      path.startsWith('/g/') ||
      path === '/a/mcp' ||
      path === '/oauth/_capture' // self-authed via agent key
    );
  };
  app.addHook('preHandler', async (req, reply) => {
    if (isPublic(req.url)) return;
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7).trim() : '';
    const payload = token ? verifyJwt(token) : null;
    if (!payload) return reply.code(401).send({ error: 'unauthorized' });
    (req as { userId?: string }).userId = payload.sub;
  });

  app.register(authRoutes);
  app.register(sourceRoutes);
  app.register(toolRoutes);
  app.register(compositeRoutes);
  app.register(virtualRoutes);
  app.register(groupRoutes);
  app.register(agentRoutes);
  app.register(scheduleRoutes);
  app.register(secretRoutes);
  app.register(observabilityRoutes);
  app.register(oauthRoutes);
  app.register(oauthProviderRoutes);
  app.register(gatewayRoutes);
  registerCapture(app);

  app.get('/healthz', async () => {
    let dbOk = false;
    try {
      await pool.query('SELECT 1');
      dbOk = true;
    } catch {
      dbOk = false;
    }
    return { status: 'ok', db: dbOk };
  });

  return app;
}
