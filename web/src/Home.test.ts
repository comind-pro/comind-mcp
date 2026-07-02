import { describe, expect, it } from 'vitest';
import { deriveSteps } from './Home.js';

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
