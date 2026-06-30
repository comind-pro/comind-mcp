import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { mcpOauth } from '../db/schema.js';
import { newId } from '../lib/id.js';
import { decrypt, encrypt } from '../secrets/vault.js';

export function callbackUrl(): string {
  return `http://${config.host}:${config.port}/oauth/callback`;
}

interface ProviderCfg {
  scope?: string;
  clientId?: string;
}

/**
 * OAuthClientProvider persisted in SQLite (one row per source). Lets the MCP SDK
 * run the full OAuth flow (discovery, DCR, PKCE, refresh) against remote MCP
 * servers like Titan, storing tokens encrypted in the vault.
 */
export class DbMcpOAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly sourceId: string,
    private readonly cfg: ProviderCfg,
  ) {}

  get redirectUrl(): string {
    return callbackUrl();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'comind-mcp',
      redirect_uris: [callbackUrl()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.cfg.scope ? { scope: this.cfg.scope } : {}),
    };
  }

  async state(): Promise<string> {
    return this.sourceId;
  }

  private async row() {
    const [r] = await db.select().from(mcpOauth).where(eq(mcpOauth.sourceId, this.sourceId));
    return r;
  }

  private async upsert(patch: Record<string, unknown>): Promise<void> {
    const existing = await this.row();
    const values = { ...patch, updatedAt: new Date() };
    if (existing) await db.update(mcpOauth).set(values).where(eq(mcpOauth.sourceId, this.sourceId));
    else await db.insert(mcpOauth).values({ id: newId(), sourceId: this.sourceId, ...values });
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const r = await this.row();
    if (r?.clientInfo) return r.clientInfo as unknown as OAuthClientInformationMixed;
    if (this.cfg.clientId) return { client_id: this.cfg.clientId } as OAuthClientInformationMixed;
    return undefined;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.upsert({ clientInfo: info });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const r = await this.row();
    return r?.tokensEnc ? (JSON.parse(decrypt(r.tokensEnc)) as OAuthTokens) : undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.upsert({ tokensEnc: encrypt(JSON.stringify(tokens)) });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    await this.upsert({ pendingAuthUrl: url.toString() });
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.upsert({ codeVerifier: verifier });
  }

  async codeVerifier(): Promise<string> {
    const r = await this.row();
    if (!r?.codeVerifier) throw new Error('Missing PKCE verifier — restart OAuth');
    return r.codeVerifier;
  }
}

export function buildMcpOAuthProvider(sourceId: string, cfg: ProviderCfg): DbMcpOAuthProvider {
  return new DbMcpOAuthProvider(sourceId, cfg);
}

/** Begin the flow: discovery + (DCR) + PKCE, returns the authorize URL to open. */
export async function startMcpOAuth(sourceId: string, mcpUrl: string, cfg: ProviderCfg): Promise<string> {
  const provider = buildMcpOAuthProvider(sourceId, cfg);
  const result = await auth(provider, { serverUrl: mcpUrl });
  if (result === 'AUTHORIZED') return ''; // already had valid tokens
  const [r] = await db.select().from(mcpOauth).where(eq(mcpOauth.sourceId, sourceId));
  if (!r?.pendingAuthUrl) throw new Error('No authorize URL produced');
  return r.pendingAuthUrl;
}

/** Finish the flow: exchange the authorization code for tokens. */
export async function completeMcpOAuth(
  sourceId: string,
  mcpUrl: string,
  code: string,
  cfg: ProviderCfg,
): Promise<void> {
  const provider = buildMcpOAuthProvider(sourceId, cfg);
  await auth(provider, { serverUrl: mcpUrl, authorizationCode: code });
}
