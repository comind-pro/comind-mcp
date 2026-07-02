import { describe, expect, it } from 'vitest';
import { mcpToolName, TOOL_NAME_RE } from './tool-name.js';

describe('mcpToolName', () => {
  it('maps stored names onto the MCP-safe charset', () => {
    expect(mcpToolName('dune.searchTables')).toBe('dune_searchTables');
    expect(mcpToolName('already_safe-Name9')).toBe('already_safe-Name9');
    expect(mcpToolName('пошук новин!')).toBe('_'.repeat(12));
    expect(mcpToolName('x'.repeat(80))).toHaveLength(64);
    for (const n of ['a.b', 'a b', 'x'.repeat(80), 'ok']) {
      expect(mcpToolName(n)).toMatch(TOOL_NAME_RE);
    }
  });
});
