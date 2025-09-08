import { describe, expect, it } from 'vitest';
import { newApiKey, newId, slugify } from './id.js';

describe('slugify', () => {
  it('lowercases and dashes non-alphanumerics', () => {
    expect(slugify('My Cool Group!')).toBe('my-cool-group');
  });
  it('trims leading/trailing separators', () => {
    expect(slugify('  --Hello--  ')).toBe('hello');
  });
  it('falls back for empty input', () => {
    expect(slugify('!!!')).toBe('item');
  });
});

describe('ids & keys', () => {
  it('generates unique ids', () => {
    expect(newId()).not.toBe(newId());
  });
  it('api key has a prefix and a cmd_ token', () => {
    const { token, prefix } = newApiKey();
    expect(token.startsWith(`cmd_${prefix}_`)).toBe(true);
    expect(prefix.length).toBe(8);
  });
});
