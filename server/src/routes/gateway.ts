import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { authenticateAgent, buildGroupServer } from '../gateway/server.js';

/**
 * Agent-facing MCP endpoint. Each group is a virtual MCP server at
 * `/g/:slug/mcp` (Streamable HTTP). Stateless: one server+transport per request.
 */
export async function gatewayRoutes(app: FastifyInstance): Promise<void> {
  app.post('/g/:groupId/mcp', async (req, reply) => {
    const { groupId } = req.params as { groupId: string };
    const auth = await authenticateAgent(groupId, req.headers.authorization);
    if (!auth) {
      return reply.code(401).send({
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

  // Stateless transport: no server-initiated streams / session teardown.
  const methodNotAllowed = async (_req: unknown, reply: any) =>
    reply.code(405).send({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed (stateless endpoint)' },
      id: null,
    });
  app.get('/g/:groupId/mcp', methodNotAllowed);
  app.delete('/g/:groupId/mcp', methodNotAllowed);
}
