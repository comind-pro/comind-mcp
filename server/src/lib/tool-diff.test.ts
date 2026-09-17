import { expect, test } from 'vitest';
import { changedFields } from './tool-diff.js';

test('changedFields: deep-equal, key order and undefined ignored', () => {
  const old = { description: 'a', inputSchema: { type: 'object', properties: { x: 1 } }, readOnly: true };
  expect(changedFields(old, { description: 'a', inputSchema: { properties: { x: 1 }, type: 'object' } })).toEqual([]);
  expect(changedFields(old, { description: 'b', readOnly: undefined })).toEqual(['description']);
  expect(changedFields(old, { inputSchema: { type: 'object', properties: { x: 2 } } })).toEqual(['inputSchema']);
});
