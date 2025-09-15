import { z } from 'zod';
import { authConfigSchema } from '../auth/config.js';
import { HttpConnector } from './http.js';
import { McpConnector } from './mcp.js';
import { OpenApiConnector } from './openapi.js';
import type { Connector } from './types.js';

const headers = z.record(z.string()).optional();

export const mcpConfigSchema = z.object({
  url: z.string().url(),
  transport: z.enum(['http', 'sse']).optional(),
  headers,
});

export const openapiConfigSchema = z
  .object({
    specUrl: z.string().url().optional(),
    spec: z.record(z.unknown()).optional(),
    baseUrl: z.string().optional(),
    headers,
  })
  .refine((c) => c.specUrl || c.spec, { message: 'Provide specUrl or spec' });

export const httpConfigSchema = z.object({
  baseUrl: z.string().url(),
  headers,
  healthPath: z.string().optional(),
  endpoints: z
    .array(
      z.object({
        name: z.string().min(1),
        method: z.string().min(1),
        path: z.string().min(1),
        description: z.string().optional(),
        inputSchema: z.record(z.unknown()).optional(),
      }),
    )
    .min(1),
});

export const sourceKind = z.enum(['mcp', 'openapi', 'http']);
export type SourceKind = z.infer<typeof sourceKind>;

/** Validate a source's config against its kind; throws ZodError on mismatch.
 *  The optional `auth` block is validated separately and preserved (connector
 *  schemas strip unknown keys). */
export function parseSourceConfig(kind: SourceKind, config: unknown): Record<string, unknown> {
  let base: Record<string, unknown>;
  switch (kind) {
    case 'mcp':
      base = mcpConfigSchema.parse(config);
      break;
    case 'openapi':
      base = openapiConfigSchema.parse(config) as Record<string, unknown>;
      break;
    case 'http':
      base = httpConfigSchema.parse(config);
      break;
  }
  const raw = config as { auth?: unknown };
  if (raw?.auth !== undefined) base.auth = authConfigSchema.parse(raw.auth);
  return base;
}

/** Build the runtime connector for a stored source. */
export function createConnector(
  kind: SourceKind,
  config: Record<string, unknown>,
  opts?: { authProvider?: import('@modelcontextprotocol/sdk/client/auth.js').OAuthClientProvider },
): Connector {
  switch (kind) {
    case 'mcp':
      return new McpConnector(mcpConfigSchema.parse(config), opts?.authProvider);
    case 'openapi':
      return new OpenApiConnector(openapiConfigSchema.parse(config));
    case 'http':
      return new HttpConnector(httpConfigSchema.parse(config));
  }
}

export type { Connector } from './types.js';
