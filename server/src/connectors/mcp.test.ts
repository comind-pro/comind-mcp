import { expect, test } from 'vitest';
import { listAllTools } from './mcp.js';

test('listAllTools follows nextCursor across pages', async () => {
  const pages: Record<string, { tools: { name: string; inputSchema: { type: 'object' } }[]; nextCursor?: string }> = {
    '': { tools: [{ name: 'a', inputSchema: { type: 'object' } }], nextCursor: 'p2' },
    p2: { tools: [{ name: 'b', inputSchema: { type: 'object' } }] },
  };
  const seen: (string | undefined)[] = [];
  const client = {
    listTools: async (params?: { cursor?: string }) => {
      seen.push(params?.cursor);
      return pages[params?.cursor ?? ''];
    },
  };
  const tools = await listAllTools(client as never);
  expect(tools.map((t) => t.name)).toEqual(['a', 'b']);
  expect(seen).toEqual([undefined, 'p2']);
});
