import { z } from 'zod';

/**
 * Optional `auth` block on a source config. Describes how to obtain a token
 * before calling the upstream. Secrets (${secret.X}) are injected before this
 * is read, so clientSecret/refreshToken arrive already resolved.
 */
/** HTTP Basic auth — username:password → `Authorization: Basic base64`.
 *  Values may be ${secret.X} (resolved before this is read). */
export const basicAuth = z.object({
  type: z.literal('basic'),
  username: z.string(),
  password: z.string(),
  /** Override the header name (default Authorization). */
  header: z.string().optional(),
});

export const oauth2ClientCredentials = z.object({
  type: z.literal('oauth2_client_credentials'),
  tokenUrl: z.string().url(),
  clientId: z.string(),
  clientSecret: z.string(),
  scope: z.string().optional(),
  /** 'body' (default) sends creds in form body; 'basic' uses HTTP Basic. */
  authStyle: z.enum(['body', 'basic']).optional(),
});

export const oauth2Refresh = z.object({
  type: z.literal('oauth2_refresh'),
  tokenUrl: z.string().url(),
  clientId: z.string(),
  clientSecret: z.string().optional(),
  refreshToken: z.string(),
  scope: z.string().optional(),
});

export const tokenRequest = z.object({
  type: z.literal('token_request'),
  tokenUrl: z.string().url(),
  method: z.enum(['POST', 'GET']).optional(),
  body: z.record(z.unknown()).optional(),
  headers: z.record(z.string()).optional(),
  /** JSON path to the token in the response, e.g. "$.data.access_token". */
  tokenPath: z.string(),
  /** JSON path to seconds-until-expiry; or use fixed ttlSec. */
  expiresPath: z.string().optional(),
  ttlSec: z.number().optional(),
  injectHeader: z.string().optional(),
  injectPrefix: z.string().optional(),
});

export const oauth2AuthorizationCode = z.object({
  type: z.literal('oauth2_authorization_code'),
  authUrl: z.string().url(),
  tokenUrl: z.string().url(),
  clientId: z.string(),
  clientSecret: z.string().optional(),
  scope: z.string().optional(),
  redirectUri: z.string().url().optional(),
});

/** MCP-native OAuth (for `mcp` sources): the SDK handles discovery, dynamic
 *  client registration, PKCE and refresh. We only persist provider state. */
export const mcpOAuth = z.object({
  type: z.literal('mcp_oauth'),
  /** Optional pre-registered client_id; omit to use Dynamic Client Registration. */
  clientId: z.string().optional(),
  scope: z.string().optional(),
});

export const authConfigSchema = z.discriminatedUnion('type', [
  basicAuth,
  oauth2ClientCredentials,
  oauth2Refresh,
  tokenRequest,
  oauth2AuthorizationCode,
  mcpOAuth,
]);

export type AuthConfig = z.infer<typeof authConfigSchema>;
