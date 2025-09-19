import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from './vault.js';

describe('vault', () => {
  it('round-trips a value', () => {
    const v = 'super-secret-token-42';
    expect(decrypt(encrypt(v))).toBe(v);
  });

  it('produces distinct ciphertexts for the same input (random IV)', () => {
    expect(encrypt('x')).not.toBe(encrypt('x'));
  });

  it('handles unicode and empty strings', () => {
    expect(decrypt(encrypt(''))).toBe('');
    expect(decrypt(encrypt('🔐 ключ'))).toBe('🔐 ключ');
  });

  it('fails to decrypt tampered ciphertext', () => {
    const blob = encrypt('value');
    const buf = Buffer.from(blob, 'base64');
    buf[buf.length - 1] ^= 0xff;
    expect(() => decrypt(buf.toString('base64'))).toThrow();
  });
});
