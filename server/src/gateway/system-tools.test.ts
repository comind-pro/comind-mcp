import { describe, expect, it } from 'vitest';
import {
  handleSystemTool,
  pickSystemTools,
  SYSTEM_TOOL_NAMES,
  SYSTEM_TOOLS,
  type SystemCtx,
  systemInstructions,
} from './system-tools.js';

const groupCtx: SystemCtx = {
  agentId: 'ag_1',
  ownerId: 'usr_1',
  scope: 'group',
  groups: [{ id: 'g1', slug: 'ops', schedulingEnabled: true }],
};
describe('SYSTEM_TOOLS metadata', () => {
  it('exposes exactly system.context + system.debug', () => {
    expect(SYSTEM_TOOLS.map((t) => t.name)).toEqual(['system.context', 'system.debug']);
    expect(SYSTEM_TOOL_NAMES.size).toBe(2);
  });

  it('every tool declares input + output schema (structured output)', () => {
    for (const t of SYSTEM_TOOLS) {
      expect(t.inputSchema, t.name).toBeDefined();
      expect((t.outputSchema as { type?: string })?.type, t.name).toBe('object');
    }
  });
});

describe('pickSystemTools', () => {
  it('returns only requested tools with MCP-safe exposed names, ignores unknown', () => {
    // Config uses canonical dotted names; the exposed MCP name is sanitized.
    expect(pickSystemTools(['system.debug']).map((t) => t.name)).toEqual(['system_debug']);
    expect(pickSystemTools(['system.whoami', 'system.bogus'])).toHaveLength(0); // legacy names gone
    expect(pickSystemTools([])).toHaveLength(0);
  });
});

describe('systemInstructions', () => {
  it('mentions only enabled tools (by their client-visible name), empty when none', () => {
    expect(systemInstructions([])).toBe('');
    const ctxOnly = systemInstructions(['system.context']);
    expect(ctxOnly).toContain('system_context');
    expect(ctxOnly).not.toContain('system_debug');
    expect(systemInstructions(['system.context', 'system.debug'])).toContain('system_debug');
  });
});

describe('handleSystemTool — errors (db-free)', () => {
  it('unknown tool returns an error result, never throws', async () => {
    const r = await handleSystemTool(groupCtx, 'system.bogus', {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Unknown system tool');
  });
});
