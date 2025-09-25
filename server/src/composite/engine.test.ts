import { describe, expect, it } from 'vitest';
import type { CallResult } from '../connectors/types.js';
import { runCompositeTrace } from './engine.js';

const ok = (text: string): CallResult => ({ content: [{ type: 'text', text }] });
const err = (text: string): CallResult => ({ content: [{ type: 'text', text }], isError: true });

describe('runCompositeTrace', () => {
  it('runs steps and fills the output template', async () => {
    const calls: string[] = [];
    const invoke = async (tool: string) => {
      calls.push(tool);
      return ok(tool === 'a' ? 'A-result' : 'B-result');
    };
    const def = {
      steps: [
        { id: 's1', tool: 'a' },
        { id: 's2', tool: 'b' },
      ],
      output: '1=${$.steps.s1.text} 2=${$.steps.s2.text}',
    };
    const { result, steps } = await runCompositeTrace(def, {}, invoke, 0);
    expect(calls).toEqual(['a', 'b']);
    expect(result.content[0].text).toBe('1=A-result 2=B-result');
    expect(steps.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('passes input and prior step output as args', async () => {
    const seen: Record<string, unknown>[] = [];
    const invoke = async (_tool: string, args: Record<string, unknown>) => {
      seen.push(args);
      return ok('done');
    };
    const def = {
      steps: [
        { id: 's1', tool: 'a', args: { who: '${$.input.name}' } },
        { id: 's2', tool: 'b', args: { prev: '$.steps.s1.text' } },
      ],
    };
    await runCompositeTrace(def, { name: 'neo' }, invoke, 0);
    expect(seen[0]).toEqual({ who: 'neo' });
    expect(seen[1]).toEqual({ prev: 'done' });
  });

  it('skips a step when `when` is falsy and stops on error', async () => {
    const calls: string[] = [];
    const invoke = async (tool: string) => {
      calls.push(tool);
      return tool === 'bad' ? err('boom') : ok('ok');
    };
    const def = {
      steps: [
        { id: 's0', tool: 'skipme', when: '$.input.flag' },
        { id: 's1', tool: 'bad' },
        { id: 's2', tool: 'never' },
      ],
    };
    const { result, steps } = await runCompositeTrace(def, { flag: false }, invoke, 0);
    expect(calls).toEqual(['bad']); // skipme skipped, never not reached
    expect(result.isError).toBe(true);
    expect(steps.find((s) => s.id === 's0')?.skipped).toBe(true);
  });
});
