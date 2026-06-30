import { z } from 'zod';
import type { CallResult } from '../connectors/types.js';
import { textResult } from '../connectors/types.js';

/**
 * Composite definition: an intent tool that deterministically runs several
 * tool calls and assembles one result.
 *
 *   {
 *     inputSchema?: <json schema for the composite's own args>,
 *     steps: [{ id, tool, args?, when? }],
 *     output?: "<template with ${$.steps.id.text}>"
 *   }
 *
 * Expressions ("$.input.x", "$.steps.id.text", "$.steps.id.content"):
 *  - as a whole arg value  → resolved to the referenced value (any type)
 *  - inside ${...} in a string → substituted as text
 * `when: "$.input.flag"` (optionally negated "!$.input.flag") gates a step.
 */
export const stepSchema = z.object({
  id: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.unknown()).optional(),
  when: z.string().optional(),
});

export const compositeDefinitionSchema = z.object({
  inputSchema: z.record(z.unknown()).optional(),
  // JSON Schema for the result — not used by the engine, surfaced to agents.
  outputSchema: z.record(z.unknown()).optional(),
  steps: z.array(stepSchema).min(1),
  output: z.union([z.string(), z.record(z.unknown())]).optional(),
});

export type CompositeDefinition = z.infer<typeof compositeDefinitionSchema>;

interface Ctx {
  input: Record<string, unknown>;
  steps: Record<string, { text: string; content: unknown; isError: boolean }>;
}

function resolvePath(expr: string, ctx: Ctx): unknown {
  const parts = expr.replace(/^\$\./, '').split('.');
  let cur: unknown = ctx;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function resolveValue(value: unknown, ctx: Ctx): unknown {
  if (typeof value === 'string') {
    // whole-string reference
    if (/^\$\.[\w.]+$/.test(value)) return resolvePath(value, ctx);
    // interpolation
    if (value.includes('${')) {
      return value.replace(/\$\{([^}]+)\}/g, (_m, e) => {
        const v = resolvePath(String(e).trim(), ctx);
        return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
      });
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, ctx));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, ctx);
    return out;
  }
  return value;
}

function isTruthy(when: string, ctx: Ctx): boolean {
  const negate = when.startsWith('!');
  const expr = negate ? when.slice(1) : when;
  const v = resolvePath(expr, ctx);
  const truthy = Array.isArray(v) ? v.length > 0 : Boolean(v);
  return negate ? !truthy : truthy;
}

function contentText(content: CallResult['content']): string {
  return content.map((c) => (typeof c.text === 'string' ? c.text : JSON.stringify(c))).join('\n');
}

type Invoke = (tool: string, args: Record<string, unknown>, depth: number) => Promise<CallResult>;

export interface StepTrace {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  text: string;
  isError: boolean;
  skipped?: boolean;
}

/** Run a composite, returning both the final result and a per-step trace
 *  (used by the authoring/test endpoint to tune the output template). */
export async function runCompositeTrace(
  rawDef: unknown,
  input: Record<string, unknown>,
  invoke: Invoke,
  depth: number,
): Promise<{ result: CallResult; steps: StepTrace[] }> {
  const def = compositeDefinitionSchema.parse(rawDef);
  const ctx: Ctx = { input: input ?? {}, steps: {} };
  const trace: StepTrace[] = [];

  for (const step of def.steps) {
    if (step.when && !isTruthy(step.when, ctx)) {
      trace.push({ id: step.id, tool: step.tool, args: {}, text: '', isError: false, skipped: true });
      continue;
    }

    const args = (resolveValue(step.args ?? {}, ctx) ?? {}) as Record<string, unknown>;
    const res = await invoke(step.tool, args, depth + 1);
    const text = contentText(res.content);
    ctx.steps[step.id] = { text, content: res.content, isError: Boolean(res.isError) };
    trace.push({ id: step.id, tool: step.tool, args, text, isError: Boolean(res.isError) });

    if (res.isError) return { result: textResult(`Step "${step.id}" failed: ${text}`, true), steps: trace };
  }

  let result: CallResult;
  if (def.output === undefined) {
    const last = def.steps[def.steps.length - 1];
    result = textResult(ctx.steps[last.id]?.text ?? '');
  } else {
    const resolved = resolveValue(def.output, ctx);
    if (typeof resolved === 'string') {
      result = textResult(resolved);
    } else {
      // Object/array template → structured output (matches the tool's
      // outputSchema). Keep a text rendering for clients without structured support.
      result = {
        content: [{ type: 'text', text: JSON.stringify(resolved, null, 2) }],
        structuredContent: resolved,
      };
    }
  }
  return { result, steps: trace };
}

export async function runComposite(
  rawDef: unknown,
  input: Record<string, unknown>,
  invoke: Invoke,
  depth: number,
): Promise<CallResult> {
  return (await runCompositeTrace(rawDef, input, invoke, depth)).result;
}
