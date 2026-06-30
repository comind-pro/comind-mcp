import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallResult, Connector, HealthResult, ToolDef } from './types.js';

export interface McpConfig {
  url: string;
  transport?: 'http' | 'sse';
  headers?: Record<string, string>;
}

/**
 * Proxies an existing MCP server. Stateless: opens a short-lived client per
 * operation so we never hold upstream sessions in the gateway. An optional
 * `authProvider` enables MCP-native OAuth (discovery/DCR/PKCE/refresh).
 */
export class McpConnector implements Connector {
  constructor(
    private readonly cfg: McpConfig,
    private readonly authProvider?: OAuthClientProvider,
  ) {}

  private makeTransport() {
    const url = new URL(this.cfg.url);
    const init = {
      ...(this.cfg.headers ? { requestInit: { headers: this.cfg.headers } } : {}),
      ...(this.authProvider ? { authProvider: this.authProvider } : {}),
    };
    return this.cfg.transport === 'sse'
      ? new SSEClientTransport(url, init)
      : new StreamableHTTPClientTransport(url, init);
  }

  private async withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: 'comind-gateway', version: '0.1.0' }, { capabilities: {} });
    await client.connect(this.makeTransport());
    try {
      return await fn(client);
    } finally {
      await client.close().catch(() => {});
    }
  }

  async listTools(): Promise<ToolDef[]> {
    return this.withClient(async (c) => {
      const res = await c.listTools();
      return res.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown> | undefined,
      }));
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallResult> {
    return this.withClient(async (c) => {
      const res = await c.callTool({ name, arguments: args });
      return {
        content: (res.content as CallResult['content']) ?? [],
        isError: Boolean(res.isError),
      };
    });
  }

  async health(): Promise<HealthResult> {
    try {
      await this.listTools();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
