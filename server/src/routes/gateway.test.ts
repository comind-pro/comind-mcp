import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

// Claude.ai's connection probe does an unauthenticated GET and rejects the
// server ("not a valid MCP server") on a 405 without a challenge. Every method
// on an unauthenticated MCP endpoint must 401 with WWW-Authenticate.
describe('gateway unauthenticated probe', () => {
  // Agent endpoint points at the root protected-resource document; group
  // endpoints at their per-group document.
  for (const [method, url, marker] of [
    ['GET', '/a/mcp', 'oauth-protected-resource"'],
    ['DELETE', '/a/mcp', 'oauth-protected-resource"'],
    ['GET', '/g/demo/mcp', 'oauth-protected-resource/g/demo/mcp"'],
  ] as const) {
    it(`${method} ${url} (no auth) → 401 + WWW-Authenticate`, async () => {
      const app = buildApp();
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toContain('resource_metadata=');
      expect(res.headers['www-authenticate']).toContain(marker);
      await app.close();
    });
  }
});
