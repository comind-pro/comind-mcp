import { expect, test } from 'vitest';
import { errorMessage, errorText } from './invoker.js';

test('errorText: text parts, else the structured body, capped', () => {
  expect(errorText({ content: [{ type: 'text', text: 'boom' }, { type: 'image' }], isError: true })).toBe('boom');
  expect(errorText({ content: [], structuredContent: { code: 404 }, isError: true })).toBe('{"code":404}');
  expect(errorText({ content: [{ type: 'text', text: 'x'.repeat(5000) }], isError: true })).toHaveLength(2000);
});

test('errorMessage: appends the cause that fetch hides', () => {
  const refused = new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') });
  expect(errorMessage(refused)).toBe('fetch failed: connect ECONNREFUSED 127.0.0.1:9');
  // happy-eyeballs AggregateError has an empty message but carries a code
  expect(errorMessage(new TypeError('fetch failed', { cause: { message: '', code: 'ETIMEDOUT' } }))).toBe(
    'fetch failed: ETIMEDOUT',
  );
  expect(errorMessage(new Error('plain'))).toBe('plain');
  expect(errorMessage('str')).toBe('str');
});
