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
  it('returns only requested tools, ignores unknown', () => {
    expect(pickSystemTools(['system.debug']).map((t) => t.name)).toEqual(['system.debug']);
    expect(pickSystemTools(['system.whoami', 'system.bogus'])).toHaveLength(0); // legacy names gone
    expect(pickSystemTools([])).toHaveLength(0);
  });
});

describe('systemInstructions', () => {
  it('mentions only enabled tools, empty when none', () => {
    expect(systemInstructions([])).toBe('');
    const ctxOnly = systemInstructions(['system.context']);
    expect(ctxOnly).toContain('system.context');
    expect(ctxOnly).not.toContain('system.debug');
    expect(systemInstructions(['system.context', 'system.debug'])).toContain('system.debug');
  });
});

describe('handleSystemTool — errors (db-free)', () => {
  it('unknown tool returns an error result, never throws', async () => {
    const r = await handleSystemTool(groupCtx, 'system.bogus', {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Unknown system tool');
  });
});
