import { describe, expect, it } from 'vitest';
import { injectSecrets } from './loader.js';

describe('injectSecrets', () => {
  const map = { API_TOKEN: 'tok-123', USER: 'alice' };

  it('replaces a placeholder inside a string', () => {
    expect(injectSecrets('Bearer ${secret.API_TOKEN}', map)).toBe('Bearer tok-123');
  });

  it('replaces deep in nested objects and arrays', () => {
    const cfg = {
      headers: { Authorization: 'Bearer ${secret.API_TOKEN}' },
      list: ['${secret.USER}', 'plain'],
    };
    expect(injectSecrets(cfg, map)).toEqual({
      headers: { Authorization: 'Bearer tok-123' },
      list: ['alice', 'plain'],
    });
  });

  it('leaves unknown placeholders empty', () => {
    expect(injectSecrets('${secret.MISSING}', map)).toBe('');
  });

  it('passes through non-string leaves unchanged', () => {
    expect(injectSecrets({ n: 42, b: true, z: null }, map)).toEqual({ n: 42, b: true, z: null });
  });
});
