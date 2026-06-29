import { describe, expect, it } from 'vitest';
import { assertSafeUrl, deepInterp, interpArgs, isPrivateIp, rateLimited, safeLookup, sanitizeHeaders, staticResult } from './virtual.js';

describe('arg interpolation', () => {
  it('substitutes ${args.x} in strings', () => {
    expect(interpArgs('id=${args.id}', { id: 42 })).toBe('id=42');
    expect(interpArgs('${args.missing}', {})).toBe(''); // missing → empty
    expect(interpArgs('${args.obj}', { obj: { a: 1 } })).toBe('{"a":1}'); // objects JSON-encoded
  });

  it('deep-interpolates across a value tree', () => {
    const out = deepInterp({ url: '/x/${args.id}', nested: ['${args.q}'] }, { id: '7', q: 'hi' });
    expect(out).toEqual({ url: '/x/7', nested: ['hi'] });
  });
});

describe('staticResult', () => {
  it('returns a plain string as raw text, no structuredContent', () => {
    const r = staticResult('hello φ');
    expect(r.content[0].text).toBe('hello φ');
    expect(r.structuredContent).toBeUndefined();
  });
  it('returns an object as JSON text + structuredContent', () => {
    const r = staticResult({ a: 1 });
    expect(JSON.parse(r.content[0].text!)).toEqual({ a: 1 });
    expect(r.structuredContent).toEqual({ a: 1 });
  });
});

describe('isPrivateIp (SSRF guard)', () => {
  it('blocks loopback / private / link-local / metadata', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.3.4', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });
  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
});

describe('assertSafeUrl', () => {
  it('rejects non-http schemes and private IP literals', () => {
    expect(() => assertSafeUrl('file:///etc/passwd')).toThrow();
    expect(() => assertSafeUrl('http://10.0.0.1/x')).toThrow(/private/i);
    expect(() => assertSafeUrl('http://169.254.169.254/latest/meta-data')).toThrow(/private/i);
    expect(() => assertSafeUrl('http://[::1]/x')).toThrow(/private/i);
  });
  it('blocks this server itself (localhost), not bypassable', () => {
    expect(() => assertSafeUrl('http://localhost/x')).toThrow(/this server/i);
  });
  it('allows a public IP literal', () => {
    expect(() => assertSafeUrl('https://8.8.8.8/')).not.toThrow();
  });
});

describe('safeLookup (connect-time rebinding pin)', () => {
  const lookup = (host: string) =>
    new Promise<{ err: Error | null; addr?: string }>((res) => safeLookup(host, {}, (err, addr) => res({ err, addr })));

  it('rejects a host that resolves to a private address', async () => {
    const { err } = await lookup('127.0.0.1'); // literal → resolves to itself, private
    expect(err).toBeTruthy();
    expect(err?.message).toMatch(/private/i);
  });
  it('returns the validated address for a public host', async () => {
    const { err, addr } = await lookup('8.8.8.8');
    expect(err).toBeNull();
    expect(addr).toBe('8.8.8.8');
  });
});

describe('sanitizeHeaders (injection guard)', () => {
  it('passes clean headers', () => {
    expect(sanitizeHeaders({ authorization: 'Bearer x', 'x-n': 1 })).toEqual({ authorization: 'Bearer x', 'x-n': '1' });
  });
  it('rejects CR/LF in name or value', () => {
    expect(() => sanitizeHeaders({ 'x\r\ny': 'a' })).toThrow(/CR\/LF/i);
    expect(() => sanitizeHeaders({ x: 'a\r\nInjected: 1' })).toThrow(/CR\/LF/i);
  });
});

describe('rateLimited (per-owner)', () => {
  it('blocks after the per-minute cap', () => {
    const owner = `rl_${Math.floor(performance.now())}_${Math.round(performance.timeOrigin)}`;
    const t = 1_000_000;
    let blockedAt = -1;
    for (let i = 0; i < 200; i++) {
      if (rateLimited(owner, t)) { blockedAt = i; break; }
    }
    expect(blockedAt).toBeGreaterThan(0); // eventually blocks within the window
  });
});
