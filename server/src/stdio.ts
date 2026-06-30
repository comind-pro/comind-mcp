/**
 * Stdio MCP entrypoint — a thin, dependency-light server that `mcp-proxy` (and
 * registries like Glama) can spawn over stdio. It does NOT run the gateway: the
 * full ComindMCP gateway is a self-hosted HTTP service (`/g/:slug/mcp`, agent-key
 * auth, Postgres or embedded PGlite). This entrypoint exposes onboarding/config
 * tools so the server is discoverable and self-deployable without any infra.
 *
 * Run:  node dist/stdio.js
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const REPO = 'https://github.com/comind-pro/comind-mcp';
const IMAGE = 'ghcr.io/comind-pro/comind-mcp';
const VERSION = '0.2.0';

const text = (t: string) => ({ content: [{ type: 'text', text: t }] });
const json = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }], structuredContent: v });

const TOOLS = [
  {
    name: 'comind.about',
    description: 'What ComindMCP is, and how agents use it.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'comind.self_host',
    description: 'How to self-host the ComindMCP gateway (Docker, run modes).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'comind.config',
    description: 'Environment-variable reference for deploying the gateway.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'comind.openapi_example',
    description: 'Worked example: turn an OpenAPI 3.x API into MCP tools via the gateway.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'comind.mcp_proxy_example',
    description: 'How to connect a running gateway V-MCP endpoint from an MCP client (HTTP / mcp-proxy).',
    inputSchema: { type: 'object', properties: {} },
  },
] as const;

const server = new Server(
  { name: 'comind-mcp', version: VERSION },
  {
    capabilities: { tools: {} },
    instructions:
      'ComindMCP is a self-hosted MCP gateway: aggregate MCP servers & APIs, curate & compose ' +
      'tools, and expose virtual MCP endpoints to agents. This stdio server is the onboarding ' +
      'face — call comind.self_host to deploy your own gateway. The gateway itself runs over HTTP ' +
      'at /g/:slug/mcp with per-agent keys.',
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as object[] }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  switch (req.params.name) {
    case 'comind.about':
      return json({
        name: 'ComindMCP',
        version: VERSION,
        what:
          'A self-hosted MCP gateway. Connect upstream MCP servers / REST APIs, curate and compose ' +
          'their tools, bundle them into groups (each a virtual MCP server with one endpoint), and ' +
          'hand groups to agents via per-agent API keys. Agents see only their granted toolset and ' +
          'can schedule themselves over MCP.',
        repository: REPO,
        gateway_endpoint: 'POST /g/:groupId/mcp  (Streamable HTTP, Authorization: Bearer <agent-key>)',
        note: 'The gateway is multi-tenant and auth-gated — deploy your own instance (see comind.self_host).',
      });
    case 'comind.self_host':
      return text(
        [
          'Run the gateway (zero-infra, embedded Postgres):',
          '',
          `  docker run -p 8787:8787 -v comind-data:/data \\`,
          `    -e SERVER_ENV=dev ${IMAGE}:latest`,
          '',
          'Production: drop SERVER_ENV=dev and set VAULT_KEY + JWT_SECRET; for horizontal scale set',
          'DATABASE_URL=postgres://… instead of the embedded default.',
          '',
          'Run modes (DATABASE_URL scheme):',
          '  file:/data/comind   embedded Postgres (PGlite) — single node, persist /data as a volume',
          '  postgres://…        external Postgres — multi-instance',
          '  memory:             throwaway / CI',
          '',
          `Source & docs: ${REPO}`,
        ].join('\n'),
      );
    case 'comind.config':
      return json({
        env: [
          {
            name: 'DATABASE_URL',
            required: false,
            default: 'file:/data/comind',
            desc: 'postgres://… or file:<dir> (embedded PGlite) or memory:',
          },
          {
            name: 'SERVER_ENV',
            required: false,
            default: 'dev',
            desc: "non-'dev' requires VAULT_KEY + JWT_SECRET (fail-fast)",
          },
          {
            name: 'VAULT_KEY',
            required: false,
            secret: true,
            desc: 'base64 32-byte AES-256-GCM key for the secrets vault',
          },
          { name: 'JWT_SECRET', required: false, secret: true, desc: 'HMAC secret for session JWTs' },
          { name: 'PUBLIC_BASE_URL', required: false, desc: 'externally reachable base URL (OAuth issuer)' },
          { name: 'PORT', required: false, default: '8787', desc: 'HTTP port' },
        ],
        image: `${IMAGE}:${VERSION}`,
        repository: REPO,
      });
    case 'comind.openapi_example':
      return json({
        summary: 'Register an OpenAPI 3.x API as a Source; each operation becomes a curated MCP tool.',
        steps: [
          '1. POST /sources — create an openapi source (spec by URL or inline + baseUrl).',
          '2. POST /sources/:id/import — the gateway parses the spec → one tool per operationId.',
          '3. PUT /groups/:id/tools — add the imported tools to a group (a virtual MCP server).',
          '4. Connect an agent to /g/:groupId/mcp with its key — it sees those tools.',
        ],
        create_source: {
          method: 'POST',
          path: '/sources',
          body: {
            name: 'petstore',
            kind: 'openapi',
            config: {
              specUrl: 'https://petstore3.swagger.io/api/v3/openapi.json',
              baseUrl: 'https://petstore3.swagger.io/api/v3',
              headers: { authorization: 'Bearer ${secret.PETSTORE_TOKEN}' },
            },
          },
        },
        inline_spec_alternative: {
          openapi: '3.0.0',
          info: { title: 'mini', version: '1.0.0' },
          servers: [{ url: 'https://api.example.com' }],
          paths: {
            '/users/{id}': {
              get: {
                operationId: 'get_user',
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
              },
            },
          },
        },
        result:
          'Tool `petstore.get_user` (etc.) — input schema derived from parameters/requestBody; secrets injected via ${secret.NAME}.',
        note: 'Run these against your self-hosted gateway (see comind.self_host). Auth: a control-plane user JWT.',
      });
    case 'comind.mcp_proxy_example':
      return json({
        summary:
          'A gateway group is a Streamable-HTTP MCP endpoint with a per-agent Bearer key. Point any ' +
          'MCP client at it directly, or bridge it to a stdio client via mcp-proxy.',
        endpoint: 'POST https://<your-gateway>/g/<groupId>/mcp',
        auth_header: 'Authorization: Bearer <AGENT_KEY>',
        clients: {
          claude_code_or_cursor:
            'claude mcp add comind --transport http https://<your-gateway>/g/<groupId>/mcp ' +
            '--header "Authorization: Bearer <AGENT_KEY>"',
          mcp_proxy_stdio_bridge:
            'mcp-proxy --transport streamablehttp --headers Authorization "Bearer <AGENT_KEY>" ' +
            'https://<your-gateway>/g/<groupId>/mcp',
          raw_jsonrpc: [
            'curl -X POST https://<your-gateway>/g/<groupId>/mcp \\',
            '  -H "Authorization: Bearer <AGENT_KEY>" \\',
            '  -H "Content-Type: application/json" \\',
            '  -H "Accept: application/json, text/event-stream" \\',
            `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
          ].join('\n'),
        },
        agent_wide_endpoint:
          'Use /a/mcp instead of /g/:groupId/mcp to expose the union of every group the agent may reach.',
        note: 'Get <groupId> + <AGENT_KEY> from the gateway: create an agent, grant it a group (Agents tab), copy the key (shown once).',
      });
    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }], isError: true };
  }
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
