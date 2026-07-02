import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { jwks, signAccessToken } from './oauth-jwt.js';

describe('oauth-jwt', () => {
  it('signs a verifiable RS256 JWT bound to the resource', () => {
    const now = 1_700_000_000_000;
    const token = signAccessToken(
      { iss: 'https://x', sub: 'agent1', aud: 'https://x/a/mcp', scope: 'mcp', clientId: 'c1', expiresInS: 3600 },
      now,
    );
    const [h, p, s] = token.split('.');
    // Signature verifies against the published public key.
    const pub = createPublicKey({ key: jwks().keys[0], format: 'jwk' });
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), pub, Buffer.from(s, 'base64url'))).toBe(true);

    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(header.alg).toBe('RS256');
    expect(header.kid).toBe(jwks().keys[0].kid);
    expect(payload.aud).toBe('https://x/a/mcp');
    expect(payload.sub).toBe('agent1');
    expect(payload.exp - payload.iat).toBe(3600);
    expect(payload.iat).toBe(now / 1000);
  });
});
