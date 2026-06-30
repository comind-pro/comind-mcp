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

const json = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }], structuredContent: v });

const NO_INPUT = { type: 'object', properties: {}, additionalProperties: false };
const READ_ONLY = { readOnlyHint: true, openWorldHint: false, idempotentHint: true, destructiveHint: false };

const TOOLS = [
  {
    name: 'comind.about',
    title: 'About ComindMCP',
    description:
      'Returns a structured overview of ComindMCP: its name, version, what it does, the repository, ' +
      'and the gateway endpoint shape. Takes no arguments. Call this first to learn what this server is ' +
      'and how agents consume it before using the other comind.* tools.',
    inputSchema: NO_INPUT,
    outputSchema: {
      type: 'object',
      required: ['name', 'version', 'what'],
      properties: {
        name: { type: 'string' },
        version: { type: 'string' },
        what: { type: 'string', description: 'One-paragraph explanation of the gateway.' },
        repository: { type: 'string', format: 'uri' },
        gateway_endpoint: { type: 'string' },
        note: { type: 'string' },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: 'comind.self_host',
    title: 'Self-host the gateway',
    description:
      'Returns the copy-paste Docker command to run your own ComindMCP gateway plus the available ' +
      'run modes (embedded Postgres via PGlite, external Postgres, or in-memory). Takes no arguments. ' +
      'Call this when you want to deploy or evaluate the full gateway.',
    inputSchema: NO_INPUT,
    outputSchema: {
      type: 'object',
      properties: {
        docker_run: { type: 'string', description: 'Ready-to-run command for a zero-infra instance.' },
        run_modes: {
          type: 'array',
          items: {
            type: 'object',
            properties: { database_url: { type: 'string' }, mode: { type: 'string' }, use_for: { type: 'string' } },
          },
        },
        repository: { type: 'string', format: 'uri' },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: 'comind.config',
    title: 'Deployment config reference',
    description:
      'Returns the full environment-variable reference for deploying the gateway — each variable with ' +
      'its requirement, default, secret flag and purpose. Takes no arguments. Use this to assemble the ' +
      'env for a production deployment.',
    inputSchema: NO_INPUT,
    outputSchema: {
      type: 'object',
      properties: {
        env: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string' },
              required: { type: 'boolean' },
              default: { type: 'string' },
              secret: { type: 'boolean' },
              desc: { type: 'string' },
            },
          },
        },
        image: { type: 'string' },
        repository: { type: 'string', format: 'uri' },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: 'comind.openapi_example',
    title: 'Example — OpenAPI → MCP tools',
    description:
      'Returns a worked, copy-paste example of turning an OpenAPI 3.x API into curated MCP tools through ' +
      'the gateway: the ordered steps, the POST /sources body (spec URL or inline spec + baseUrl + ' +
      'secret-templated headers), and the resulting tool name. Takes no arguments.',
    inputSchema: NO_INPUT,
    outputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        steps: { type: 'array', items: { type: 'string' } },
        create_source: { type: 'object', description: 'POST /sources request body.' },
        inline_spec_alternative: { type: 'object' },
        result: { type: 'string' },
        note: { type: 'string' },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: 'comind.mcp_proxy_example',
    title: 'Example — connect a V-MCP endpoint',
    description:
      'Returns ready-to-use commands for connecting a running gateway group endpoint from an MCP client: ' +
      'the HTTP endpoint + Bearer header, a `claude mcp add` line, an `mcp-proxy` stdio bridge, and a raw ' +
      'JSON-RPC curl. Takes no arguments. Use this once you have a deployed gateway, a group id and an agent key.',
    inputSchema: NO_INPUT,
    outputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        endpoint: { type: 'string' },
        auth_header: { type: 'string' },
        clients: { type: 'object', description: 'Per-client connection commands.' },
        agent_wide_endpoint: { type: 'string' },
        note: { type: 'string' },
      },
    },
    annotations: READ_ONLY,
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
      return json({
        docker_run: `docker run -p 8787:8787 -v comind-data:/data -e SERVER_ENV=dev ${IMAGE}:latest`,
        production_note:
          'Drop SERVER_ENV=dev and set VAULT_KEY + JWT_SECRET; for horizontal scale use DATABASE_URL=postgres://… instead of the embedded default.',
        run_modes: [
          {
            database_url: 'file:/data/comind',
            mode: 'embedded Postgres (PGlite)',
            use_for: 'zero-infra single node; persist /data as a volume',
          },
          { database_url: 'postgres://…', mode: 'external Postgres', use_for: 'multi-instance / horizontal scale' },
          { database_url: 'memory:', mode: 'embedded, in-memory', use_for: 'throwaway / CI' },
        ],
        repository: REPO,
      });
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
