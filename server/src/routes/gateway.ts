import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { authenticateAgent, authenticateAgentAll, buildAgentServer, buildGroupServer } from '../gateway/server.js';

/**
 * Agent-facing MCP endpoint. Each group is a virtual MCP server at
 * `/g/:slug/mcp` (Streamable HTTP). Stateless: one server+transport per request.
 */
export async function gatewayRoutes(app: FastifyInstance): Promise<void> {
  app.post('/g/:groupId/mcp', async (req, reply) => {
    const { groupId } = req.params as { groupId: string };
    const auth = await authenticateAgent(groupId, req.headers.authorization);
    if (!auth) {
      // Point OAuth-capable clients (ChatGPT, Claude.ai) at our protected-resource
      // metadata so they can run the OAuth flow (RFC 9728).
      return reply
        .code(401)
        .header(
          'WWW-Authenticate',
          `Bearer resource_metadata="${config.publicBaseUrl}/.well-known/oauth-protected-resource/g/${groupId}/mcp"`,
        )
        .send({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized' },
          id: null,
        });
    }

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
  app.post('/a/mcp', async (req, reply) => {
    const auth = await authenticateAgentAll(req.headers.authorization);
    if (!auth) {
      return reply
        .code(401)
        .header(
          'WWW-Authenticate',
          `Bearer resource_metadata="${config.publicBaseUrl}/.well-known/oauth-protected-resource/a/mcp"`,
        )
        .send({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    }
    const server = await buildAgentServer(auth);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.raw.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // Stateless transport: no server-initiated streams / session teardown.
  const methodNotAllowed = async (_req: unknown, reply: any) =>
    reply.code(405).send({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed (stateless endpoint)' },
      id: null,
    });
  app.get('/g/:groupId/mcp', methodNotAllowed);
  app.delete('/g/:groupId/mcp', methodNotAllowed);
  app.get('/a/mcp', methodNotAllowed);
  app.delete('/a/mcp', methodNotAllowed);
}
