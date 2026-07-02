import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { authenticateAgent, authenticateAgentAll, buildAgentServer, buildGroupServer } from '../gateway/server.js';

/**
 * Point OAuth-capable clients (ChatGPT, Claude.ai) at our protected-resource
 * metadata so they can run the OAuth flow (RFC 9728). Must be returned for EVERY
 * method on an unauthenticated MCP endpoint — Claude.ai's connection probe does
 * an unauthenticated GET and treats a 405 (no challenge) as "not a valid MCP
 * server", so GET/DELETE must 401-challenge too, not 405.
 */
// `metaSuffix` is appended to the protected-resource metadata path: '' points at
// the root document (what Claude.ai's connection probe fetches — mirrors
// known-good servers), '/g/<id>/mcp' at the per-group document.
function challenge(reply: FastifyReply, metaSuffix: string): FastifyReply {
  // Plain-text body (not a JSON-RPC error): a connection probe that parses the
  // 401 body as an MCP message must fall back to the WWW-Authenticate challenge,
  // not mistake it for an application-level error. Mirrors known-good servers.
  return reply
    .code(401)
    .header(
      'WWW-Authenticate',
      `Bearer resource_metadata="${config.publicBaseUrl}/.well-known/oauth-protected-resource${metaSuffix}"`,
    )
    .header('content-type', 'text/plain; charset=utf-8')
    .header('x-content-type-options', 'nosniff')
    .send('missing bearer token');
}

/** Stateless transport: no server-initiated streams / session teardown. */
function methodNotAllowed(reply: FastifyReply): FastifyReply {
  return reply
    .code(405)
    .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless endpoint)' }, id: null });
}

/**
 * Agent-facing MCP endpoint. Each group is a virtual MCP server at
 * `/g/:slug/mcp` (Streamable HTTP). Stateless: one server+transport per request.
 */
export async function gatewayRoutes(app: FastifyInstance): Promise<void> {
  app.post('/g/:groupId/mcp', async (req, reply) => {
    const { groupId } = req.params as { groupId: string };
    const auth = await authenticateAgent(groupId, req.headers.authorization);
    if (!auth) return challenge(reply, `/g/${groupId}/mcp`);

    const server = await buildGroupServer(auth);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.raw.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // Agent-wide endpoint: one URL exposing the union of tools across every group
  // the authenticated agent may reach. Bearer = agent key or agent-wide OAuth token.
  // `metaSuffix` selects which protected-resource doc the 401 challenge points at.
  type ReqLike = { headers: { authorization?: string }; raw: import('node:http').IncomingMessage; body?: unknown };
  const serveAgent = (metaSuffix: string) => async (req: ReqLike, reply: FastifyReply) => {
    const auth = await authenticateAgentAll(req.headers.authorization);
    if (!auth) return challenge(reply, metaSuffix);
    const server = await buildAgentServer(auth);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.raw.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  const agentNoStream = (metaSuffix: string) => async (req: ReqLike, reply: FastifyReply) => {
    const auth = await authenticateAgentAll(req.headers.authorization);
    return auth ? methodNotAllowed(reply) : challenge(reply, metaSuffix);
  };
  app.post('/a/mcp', serveAgent(''));
  app.get('/a/mcp', agentNoStream(''));
  app.delete('/a/mcp', agentNoStream(''));

  // Alias with per-path discovery (401 → its OWN protected-resource doc, not the
  // root). A URL Claude.ai has no cached verdict for → forces a fresh connection
  // probe we can observe. Routes to `server` via the /a/mcp ingress prefix. (temp)
  app.post('/a/mcp/x', serveAgent('/a/mcp/x'));
  app.get('/a/mcp/x', agentNoStream('/a/mcp/x'));
  app.delete('/a/mcp/x', agentNoStream('/a/mcp/x'));

  // GET/DELETE for groups: unauthenticated → 401-challenge; authenticated → 405.
  const groupNoStream = async (req: { params: unknown; headers: { authorization?: string } }, reply: FastifyReply) => {
    const { groupId } = req.params as { groupId: string };
    const auth = await authenticateAgent(groupId, req.headers.authorization);
    return auth ? methodNotAllowed(reply) : challenge(reply, `/g/${groupId}/mcp`);
  };
  app.get('/g/:groupId/mcp', groupNoStream);
  app.delete('/g/:groupId/mcp', groupNoStream);
}
