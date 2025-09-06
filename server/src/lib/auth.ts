import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

// --- password hashing (scrypt, no external deps) ---

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const dk = scryptSync(password, salt, 32);
  return `${salt.toString('hex')}:${dk.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const dk = scryptSync(password, Buffer.from(saltHex, 'hex'), 32);
  const expected = Buffer.from(hashHex, 'hex');
  return dk.length === expected.length && timingSafeEqual(dk, expected);
}

// --- minimal HS256 JWT ---

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString('base64url');

function sign(data: string): string {
  return createHmac('sha256', config.jwtSecret).update(data).digest('base64url');
}

export interface JwtPayload {
  sub: string; // userId
  exp: number; // epoch seconds
}

export function signJwt(userId: string, ttlSec = 7 * 24 * 3600): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const body = b64url(JSON.stringify({ sub: userId, exp }));
  const data = `${header}.${body}`;
  return `${data}.${sign(data)}`;
}

export function verifyJwt(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = sign(`${header}.${body}`);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as JwtPayload;
    if (!payload.sub || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
