import { createHash, createPrivateKey, generateKeyPairSync, type JsonWebKey, type KeyObject, sign } from 'node:crypto';

/**
 * Signs inbound-OAuth access tokens as RS256 JWTs so MCP clients (Claude.ai
 * connectors, ChatGPT) that decode/verify the token — reading the `aud`
 * (resource) and `exp` claims per MCP auth spec 2025-06-18 — accept them.
 *
 * The gateway still validates by `hashKey(token)` DB lookup (see
 * gateway/server.ts), NOT by signature — the JWT shape is purely for the
 * client's benefit. The public key is published at /.well-known/jwks.json.
 *
 * Key source: `OAUTH_SIGNING_KEY` (base64 PKCS#8 PEM) for a stable key across
 * deploys; otherwise a fresh keypair is generated at boot.
 * ponytail: ephemeral boot key is fine because our own validation is
 * hash-based, not signature-based — set OAUTH_SIGNING_KEY only if an external
 * verifier must survive redeploys.
 */
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

function loadOrGenerateKey(): { privateKey: KeyObject; publicJwk: JsonWebKey & { kid: string } } {
  let privateKey: KeyObject;
  const envKey = process.env.OAUTH_SIGNING_KEY;
  if (envKey) {
    privateKey = createPrivateKey(Buffer.from(envKey, 'base64').toString('utf8'));
  } else {
    if (process.env.SERVER_ENV && process.env.SERVER_ENV !== 'dev' && process.env.SERVER_ENV !== 'test') {
      console.warn('[oauth-jwt] OAUTH_SIGNING_KEY unset — using an ephemeral boot key (jwks rotates on redeploy).');
    }
    privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  }
  const jwk = privateKey.export({ format: 'jwk' }) as JsonWebKey & { d?: string };
  // kid = short hash of the public modulus, so it's stable for a given key.
  const kid = createHash('sha256').update(jwk.n ?? '').digest('base64url').slice(0, 16);
  const publicJwk = { kty: jwk.kty, n: jwk.n, e: jwk.e, use: 'sig', alg: 'RS256', kid } as JsonWebKey & { kid: string };
  return { privateKey, publicJwk };
}

const { privateKey, publicJwk } = loadOrGenerateKey();

/** The public JWK set served at /.well-known/jwks.json. */
export function jwks(): { keys: JsonWebKey[] } {
  return { keys: [publicJwk] };
}

export interface AccessTokenClaims {
  iss: string;
  sub: string; // agentId
  aud: string; // the V-MCP resource URL (…/a/mcp or …/g/<id>/mcp)
  scope: string;
  clientId: string;
  expiresInS: number;
}

/** Sign an RS256 JWT access token. `nowMs` is injectable for tests. */
export function signAccessToken(c: AccessTokenClaims, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: publicJwk.kid };
  const payload = {
    iss: c.iss,
    sub: c.sub,
    aud: c.aud,
    azp: c.clientId,
    scope: c.scope,
    iat: now,
    exp: now + c.expiresInS,
    jti: b64url(createHash('sha256').update(`${c.sub}:${now}:${c.aud}`).digest()).slice(0, 22),
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64url(signature)}`;
}
