import { authConfigSchema } from './config.js';
import { getAuthHeader } from './token-manager.js';

/**
 * If a source config has an `auth` block, obtain a token (cached/refreshed) and
 * merge it into the outgoing headers. Returns config with `auth` stripped so the
 * connector only sees concrete headers.
 */
export async function applyAuth(
  sourceId: string,
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!config.auth) return config;
  const auth = authConfigSchema.parse(config.auth);
  // MCP-native OAuth is handled by the SDK provider on the transport, not via a header.
  if (auth.type === 'mcp_oauth') {
    const { auth: _omit, ...rest } = config;
    return rest;
  }
  const header = await getAuthHeader(sourceId, auth);
  const headers = { ...((config.headers as Record<string, string>) ?? {}), [header.name]: header.value };
  const { auth: _omit, ...rest } = config;
  return { ...rest, headers };
}
