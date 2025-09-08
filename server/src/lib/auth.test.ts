import { describe, expect, it } from 'vitest';
import { hashPassword, signJwt, verifyJwt, verifyPassword } from './auth.js';

describe('password hashing', () => {
  it('verifies a correct password', () => {
    const h = hashPassword('correct horse battery');
    expect(verifyPassword('correct horse battery', h)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const h = hashPassword('s3cret');
    expect(verifyPassword('wrong', h)).toBe(false);
  });

  it('produces a different salt each time', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });
});

describe('JWT', () => {
  it('round-trips the subject', () => {
    const token = signJwt('user-123');
    expect(verifyJwt(token)?.sub).toBe('user-123');
  });

  it('rejects a tampered token', () => {
    const token = signJwt('user-123');
    const tampered = token.slice(0, -3) + 'aaa';
    expect(verifyJwt(tampered)).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = signJwt('user-123', -10);
    expect(verifyJwt(token)).toBeNull();
  });

  it('rejects garbage', () => {
    expect(verifyJwt('not.a.jwt')).toBeNull();
    expect(verifyJwt('')).toBeNull();
  });
});
