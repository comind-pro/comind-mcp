import type { CallResult } from '../connectors/types.js';
import { parseJson } from './compact.js';

interface Node {
  leaf: boolean;
  kids: Map<string, Node>;
}

/** 'items[].title' → ['items','title']; 'a.b' → ['a','b']. */
export function normalizePath(field: string): string[] {
  return field.replace(/\[\]/g, '').split('.').filter(Boolean);
}

/** Keep only the given dot paths (arrays traversed). matched=false when nothing matched. */
export function project(value: unknown, fields: string[]): { value: unknown; matched: boolean } {
  const root: Node = { leaf: false, kids: new Map() };
  for (const f of fields) {
    let n = root;
    for (const seg of normalizePath(f)) {
      if (!n.kids.has(seg)) n.kids.set(seg, { leaf: false, kids: new Map() });
      n = n.kids.get(seg) as Node;
    }
    n.leaf = true;
  }
  let matched = false;
  const walk = (v: unknown, node: Node): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, node)).filter((x) => x !== undefined);
    if (typeof v !== 'object' || v === null) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const kid = node.kids.get(k);
      if (!kid) continue;
      if (kid.leaf) {
        matched = true;
        out[k] = x;
      } else {
        const sub = walk(x, kid);
        if (sub !== undefined) out[k] = sub;
      }
    }
    return out;
  };
  const value2 = walk(value, root);
  return matched ? { value: value2, matched } : { value, matched };
}

/** Cut every array to its first `limit` items; `omitted` = total items removed. */
export function limitArrays(value: unknown, limit: number): { value: unknown; omitted: number } {
  let omitted = 0;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      omitted += Math.max(0, v.length - limit);
      return v.slice(0, limit).map(walk);
    }
    if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value), omitted };
}

const isTree = (v: unknown) => typeof v === 'object' && v !== null;

/** Apply owner then agent intent to a CallResult (text JSON + structuredContent). Adds trailing notes. */
export function projectResult(
  r: CallResult,
  owner: { fields?: string[] | null; limit?: number | null },
  agent: { fields?: string[]; limit?: number },
): CallResult {
  const ownerFields = owner.fields?.length ? owner.fields : undefined;
  const agentFields = agent.fields?.length ? agent.fields : undefined;
  const limits = [owner.limit, agent.limit].filter((n): n is number => typeof n === 'number' && n > 0);
  const limit = limits.length ? Math.min(...limits) : undefined;
  if (r.isError || (!ownerFields && !agentFields && limit === undefined)) return r;

  let nomatch = false;
  let omitted = 0;
  const apply = (v: unknown): unknown => {
    let cur = v;
    if (ownerFields) cur = project(cur, ownerFields).value;
    if (agentFields) {
      const p = project(cur, agentFields);
      nomatch = !p.matched;
      cur = p.value;
    }
    if (limit !== undefined) {
      const l = limitArrays(cur, limit);
      omitted = l.omitted;
      cur = l.value;
    }
    return cur;
  };
  const isText = (b: CallResult['content'][number]) => b.type === 'text' && typeof b.text === 'string';
  const texts = r.content.filter(isText).map((b) => b.text as string);
  if (!texts.length) return r;
  const text = texts.join('\n');
  // one data block replaces all text blocks, at the first text block's position
  const first = r.content.findIndex(isText);
  const replaceAt = (t: string, notes: string[] = []): CallResult => ({
    ...r,
    content: [
      ...r.content.flatMap((b, i) => (i === first ? [{ type: 'text', text: t }] : isText(b) ? [] : [b])),
      ...notes.map((n) => ({ type: 'text', text: n })),
    ],
  });

  let parsed: unknown;
  try {
    parsed = parseJson(text);
  } catch {
    // ponytail: non-JSON text → only a line limit; _fields ignored (structuredContent still projected below)
    const out = limit === undefined ? replaceAt(text) : replaceAt(text.split('\n').slice(0, limit).join('\n'));
    if (!isTree(r.structuredContent)) return limit === undefined && texts.length === 1 ? r : out;
    out.structuredContent = apply(r.structuredContent);
    return out;
  }
  if (!isTree(parsed)) return r;

  const out = replaceAt(JSON.stringify(apply(parsed)));
  const notes: string[] = [];
  if (nomatch) notes.push(`(_fields matched nothing: ${agentFields?.join(', ')})`);
  if (omitted > 0) notes.push(`(_limit ${limit}: ${omitted} ${omitted === 1 ? 'item' : 'items'} omitted)`);
  out.content.push(...notes.map((n) => ({ type: 'text', text: n })));
  if (isTree(r.structuredContent)) out.structuredContent = apply(r.structuredContent);
  return out;
}
