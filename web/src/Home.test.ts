import { describe, expect, it } from 'vitest';
import type { Agent, Secret, Source } from './api.js';
import { bucketDays, deriveAttention, deriveSteps } from './Home.js';

describe('deriveSteps', () => {
  it('marks all steps undone when every count is zero', () => {
    const steps = deriveSteps({ sources: 0, tools: 0, groups: 0, agents: 0 });
    expect(steps).toHaveLength(4);
    expect(steps.every((s) => !s.done)).toBe(true);
  });

  it('marks only the sources step done when sources exist', () => {
    const steps = deriveSteps({ sources: 1, tools: 0, groups: 0, agents: 0 });
    expect(steps[0].done).toBe(true);
    expect(steps[1].done).toBe(false);
    expect(steps[2].done).toBe(false);
    expect(steps[3].done).toBe(false);
    const firstOpen = steps.findIndex((s) => !s.done);
    expect(firstOpen).toBe(1);
  });

  it('marks every step done when every count is nonzero', () => {
    const steps = deriveSteps({ sources: 3, tools: 5, groups: 2, agents: 1 });
    expect(steps.every((s) => s.done)).toBe(true);
  });
});

describe('bucketDays', () => {
  const now = 1_700_000_000_000;
  const day = 86_400_000;

  it('returns all zeros for no timestamps', () => {
    expect(bucketDays([], now)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('puts a fresh call in the last (today) bucket and an old one earlier', () => {
    const buckets = bucketDays([now - 1000, now - 6 * day], now);
    expect(buckets[6]).toBe(1);
    expect(buckets[0]).toBe(1);
    expect(buckets.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('ignores timestamps outside the window and accepts ISO strings', () => {
    const buckets = bucketDays([now - 8 * day, new Date(now).toISOString()], now);
    expect(buckets.reduce((a, b) => a + b, 0)).toBe(1);
    expect(buckets[6]).toBe(1);
  });
});

describe('deriveAttention', () => {
  const src = (p: Partial<Source>): Source =>
    ({
      id: 'x',
      name: 'x',
      kind: 'mcp',
      config: {},
      status: 'ok',
      statusMessage: null,
      projectId: 'p',
      createdByAgentId: null,
      ...p,
    }) as Source;

  it('lists failing sources with a readable zod message, pending secrets, drift and idle agents', () => {
    const items = deriveAttention(
      [
        src({ name: 'mail', status: 'error', statusMessage: '[{"path":["pass"],"message":"Required"}]' }),
        src({ name: 'api', drift: { new: ['a'], changed: [], gone: [] } }),
        src({ name: 'fine' }),
      ],
      [{ name: 'KEY', pending: true } as Secret, { name: 'SET', pending: false } as Secret],
      [{ name: 'bot', groups: [] } as unknown as Agent],
    );
    expect(items.map((i) => i.title)).toEqual([
      'mail is failing',
      'Secret KEY has no value',
      'api has tool updates',
      'Agent bot has no access',
    ]);
    expect(items[0].detail).toBe('pass: Required');
  });
});
