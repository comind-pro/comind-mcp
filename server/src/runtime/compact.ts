import type { CallResult } from '../connectors/types.js';

export const COMPACT_MIN_BYTES = 2048;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** nulls/""/undefined dropped from objects, floats rounded to 6 dp, base64 → placeholder. */
export function cleanJson(v: unknown): unknown {
  if (typeof v === 'number') return Number.isInteger(v) ? v : Number(v.toFixed(6));
  if (typeof v === 'string') {
    const b64 = v.length >= 200 && /^[A-Za-z0-9+/=\s]+$/.test(v);
    return b64 || v.startsWith('data:') ? `<base64 ${v.length} chars>` : v;
  }
  if (Array.isArray(v)) return v.map(cleanJson);
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== null && x !== undefined && x !== '') out[k] = cleanJson(x);
    return out;
  }
  return v;
}

const cell = (x: unknown): string =>
  x === undefined || x === null ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x);

/** Table lines (header + rows) when `arr` is ≥3 objects with ≥60% key overlap, else null. */
function tableLines(arr: unknown[]): string[] | null {
  if (arr.length < 3 || !arr.every(isObj)) return null;
  const rows = arr as Record<string, unknown>[];
  const union = [...new Set(rows.flatMap((o) => Object.keys(o)))];
  const overlap = rows.reduce((s, o) => s + Object.keys(o).length / union.length, 0) / rows.length;
  if (overlap < 0.6) return null;
  return [union.join(' | '), ...rows.map((o) => union.map((k) => cell(o[k])).join(' | '))];
}

function arrayLines(key: string, arr: unknown[], pad: string): string[] {
  const t = tableLines(arr);
  if (!t) return [`${pad}${key ? `${key}: ` : ''}${JSON.stringify(arr)}`];
  return [`${pad}${key ? `${key} ` : ''}(${arr.length} rows):`, ...t.map((l) => pad + l)];
}

function objectLines(o: Record<string, unknown>, ind: number): string[] {
  const pad = ' '.repeat(ind);
  return Object.entries(o).flatMap(([k, x]): string[] => {
    if (Array.isArray(x)) return arrayLines(k, x, pad);
    if (isObj(x)) return Object.keys(x).length ? [`${pad}${k}:`, ...objectLines(x, ind + 2)] : [`${pad}${k}: {}`];
    return [`${pad}${k}: ${cell(x)}`];
  });
}

/** JSON value → flat text (key: value lines, tables for uniform object arrays). */
export function renderFlat(v: unknown): string {
  if (Array.isArray(v)) return arrayLines('', v, '').join('\n');
  if (isObj(v)) return objectLines(v, 0).join('\n');
  return cell(v);
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/** Trim each line and squeeze blank runs to one blank line. */
function tidy(lines: string[]): string {
  const out: string[] = [];
  for (const l of lines) if (l !== '' || out[out.length - 1] !== '') out.push(l);
  return out.join('\n').trim();
}

/** HTML → readable text with `text (url)` links. */
export function htmlToText(html: string): string {
  // ponytail: regex, not a parser — fine for readable text, not for malformed nesting
  const s = html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<br\s*\/?>|<\/(p|div|h\d|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] as string)
    .replace(/[ \t]+/g, ' ');
  return tidy(s.split('\n').map((l) => l.trim()));
}

/** Logs/plain text: trim, dedupe consecutive identical lines as ` (×N)`, squeeze blank lines. */
export function squeezeText(text: string): string {
  const out: string[] = [];
  let n = 1;
  for (const l of text.split('\n').map((x) => x.trimEnd())) {
    const last = out.length - 1;
    if (l !== '' && last >= 0 && out[last] !== '' && (out[last] === l || out[last] === `${l} (×${n})`)) {
      n++;
      out[last] = `${l} (×${n})`;
    } else {
      out.push(l);
      n = 1;
    }
  }
  return tidy(out);
}

/** Detects JSON / HTML / text and applies the matching compaction. Returns the input when not smaller. */
export function compactText(text: string): string {
  let out: string | undefined;
  try {
    const v = JSON.parse(text);
    if (typeof v === 'object' && v !== null) out = renderFlat(cleanJson(v));
  } catch {
    /* not JSON */
  }
  if (out === undefined) {
    const html = /^\s*<!doctype|^\s*<html/i.test(text) || (text.match(/<\/?[a-z][^>]*>/gi)?.length ?? 0) >= 20;
    out = html ? htmlToText(text) : squeezeText(text);
  }
  return out.length < text.length ? out : text;
}

/** CallResult wrapper: text blocks merged into one compacted block; errors and short results untouched. */
export function compactResult(r: CallResult): CallResult {
  const isText = (b: CallResult['content'][number]) => b.type === 'text' && typeof b.text === 'string';
  const texts = r.content.filter(isText).map((b) => b.text as string);
  const joined = texts.join('\n');
  if (r.isError || !texts.length || joined.length < COMPACT_MIN_BYTES) return r;
  const text = compactText(joined);
  const { structuredContent: sc, ...rest } = r;
  const out: CallResult = { ...rest, content: [...r.content.filter((b) => !isText(b)), { type: 'text', text }] };
  if (sc !== undefined) {
    const cleaned = cleanJson(sc);
    if (!(text !== joined && JSON.stringify(cleaned).length >= COMPACT_MIN_BYTES)) out.structuredContent = cleaned;
  }
  return out;
}
