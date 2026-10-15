# Compact Tool Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make large tool results cheaper for the agent's context in the same call: auto-compaction of JSON/HTML/log text and field/row projection by intent, applied in the gateway at depth 0.

**Architecture:** Two pure modules (`runtime/compact.ts`, `runtime/projection.ts`) are wired into `invokeTool` at depth 0 only, driven by the workspace's `compactResults` flag, the tool's `outputFields`/`outputLimit`, and the reserved call args `_fields`/`_limit`. The gateway advertises the reserved args in every tool schema; call logs record bytes in/out; admin exposes the three knobs and the savings.

**Tech Stack:** TypeScript, Fastify, drizzle-orm (Postgres / PGlite `DATABASE_URL=memory:`), vitest, React 18 + @testing-library/react, biome.

**Spec:** `docs/superpowers/specs/2026-10-14-compact-results-design.md`

## Global Constraints

- No new dependencies. HTML stripping and JSON rendering are hand-written.
- Compaction/projection at `depth === 0` only; nested composite/python calls get raw results.
- Errors (`isError`) are never compacted or projected.
- Compaction threshold `COMPACT_MIN_BYTES = 2048`; compaction never returns something larger than its input.
- `_fields`/`_limit` are stripped from args before dispatch and never reach upstream.
- Run tests with `DATABASE_URL=memory:`; lint with `./node_modules/.bin/biome check --write`; use `rtk proxy <cmd>` for vitest/git/curl when the output matters (the shell hook truncates it).
- Commit after each task; commit messages end with the Co-Authored-By trailer given by the harness.

## Review Focus

1. A JSON result whose top-level array has heterogeneous objects (keys overlap < 60 %) must render as inline JSON lines, not a ragged table — Task 1 test.
2. `_fields` that match nothing must return the original value plus a note, never an empty object — Task 1 test.
3. A composite step calling a tool must receive raw JSON even when the workspace has `compactResults` on — Task 2 test.
4. A tool schema with `additionalProperties: false` must still accept `_fields`/`_limit` after `tools/list` rewriting — Task 2 test.
5. A result below the threshold must come back byte-identical with `bytesIn === bytesOut` — Task 2 test.

---

### Task 1: compact.ts and projection.ts (pure modules)

**Files:**
- Create: `server/src/runtime/compact.ts`
- Create: `server/src/runtime/projection.ts`
- Test: `server/src/runtime/compact.test.ts`, `server/src/runtime/projection.test.ts`

**Interfaces:**
- Produces (compact.ts):
  ```ts
  export const COMPACT_MIN_BYTES = 2048;
  /** nulls/""/undefined dropped from objects, floats rounded to 6 dp, base64 → placeholder. */
  export function cleanJson(v: unknown): unknown;
  /** JSON value → flat text (key: value lines, tables for uniform object arrays). */
  export function renderFlat(v: unknown): string;
  /** HTML → readable text with `text (url)` links. */
  export function htmlToText(html: string): string;
  /** Logs/plain text: trim, dedupe consecutive identical lines as ` (×N)`, squeeze blank lines. */
  export function squeezeText(text: string): string;
  /** Detects JSON / HTML / text and applies the matching compaction. Returns the input when not smaller. */
  export function compactText(text: string): string;
  /** CallResult wrapper: text blocks merged into one compacted block; errors and short results untouched. */
  export function compactResult(r: CallResult): CallResult;
  ```
- Produces (projection.ts):
  ```ts
  /** 'items[].title' → ['items','title']; 'a.b' → ['a','b']. */
  export function normalizePath(field: string): string[];
  /** Keep only the given dot paths (arrays traversed). matched=false when nothing matched. */
  export function project(value: unknown, fields: string[]): { value: unknown; matched: boolean };
  /** Cut every array to its first `limit` items; `omitted` = total items removed. */
  export function limitArrays(value: unknown, limit: number): { value: unknown; omitted: number };
  /** Apply owner then agent intent to a CallResult (text JSON + structuredContent). Adds trailing notes. */
  export function projectResult(
    r: CallResult,
    owner: { fields?: string[] | null; limit?: number | null },
    agent: { fields?: string[]; limit?: number },
  ): CallResult;
  ```

- [ ] **Step 1: Write failing tests for compact.ts**

```ts
// server/src/runtime/compact.test.ts
import { describe, expect, it } from 'vitest';
import { cleanJson, COMPACT_MIN_BYTES, compactResult, compactText, htmlToText, renderFlat, squeezeText } from './compact.js';

const issues = Array.from({ length: 25 }, (_, i) => ({
  id: i + 1,
  title: `Issue number ${i + 1} with a reasonably long title to pad bytes`,
  state: i % 2 ? 'open' : 'closed',
  assignee: null,
  labels: [],
  url: `https://example.com/issues/${i + 1}`,
  body: '',
}));

describe('cleanJson', () => {
  it('drops null/empty strings, keeps empty arrays, rounds floats, masks base64', () => {
    const v = cleanJson({ a: null, b: '', c: [], d: {}, e: 1.23456789012, f: 'A'.repeat(300), g: 'data:image/png;base64,AAAA' });
    expect(v).toEqual({ c: [], d: {}, e: 1.234568, f: '<base64 300 chars>', g: '<base64 26 chars>' });
  });
});

describe('renderFlat', () => {
  it('renders a uniform object array as a table', () => {
    const out = renderFlat({ total: 2, items: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }] });
    expect(out).toBe('total: 2\nitems (3 rows):\nid | name\n1 | a\n2 | b\n3 | c');
  });
  it('keeps a heterogeneous array as inline JSON', () => {
    const out = renderFlat({ items: [{ id: 1 }, { name: 'x' }, { other: true }] });
    expect(out).toBe('items: [{"id":1},{"name":"x"},{"other":true}]');
  });
  it('indents nested objects', () => {
    expect(renderFlat({ user: { name: 'Ann', address: { city: 'Kyiv' } } })).toBe('user:\n  name: Ann\n  address:\n    city: Kyiv');
  });
});

describe('htmlToText', () => {
  it('strips scripts/styles, keeps link targets and block breaks', () => {
    const html = '<html><head><title>T</title><style>b{}</style></head><body><script>x()</script><h1>Hi &amp; bye</h1><p>See <a href="https://x.y">docs</a>.</p><p>Next</p></body></html>';
    expect(htmlToText(html)).toBe('Hi & bye\nSee docs (https://x.y).\nNext');
  });
});

describe('squeezeText', () => {
  it('dedupes consecutive identical lines and squeezes blank runs', () => {
    expect(squeezeText('a  \na\na\n\n\n\nb')).toBe('a (×3)\n\nb');
  });
});

describe('compactText', () => {
  it('turns big JSON into a table and shrinks it', () => {
    const text = JSON.stringify({ total_count: 25, items: issues });
    const out = compactText(text);
    expect(out.length).toBeLessThan(text.length / 2);
    expect(out.startsWith('total_count: 25\nitems (25 rows):\nid | title | state | labels | url')).toBe(true);
    expect(out).not.toContain('assignee');
  });
  it('returns the input when compaction would not shrink it', () => {
    const text = 'x'.repeat(3000);
    expect(compactText(text)).toBe(text);
  });
});

describe('compactResult', () => {
  const big = { content: [{ type: 'text', text: JSON.stringify({ items: issues }) }], structuredContent: { items: issues } };
  it('leaves short results and errors alone', () => {
    const short = { content: [{ type: 'text', text: '{"a":1}' }] };
    expect(compactResult(short)).toBe(short);
    const err = { ...big, isError: true };
    expect(compactResult(err)).toBe(err);
  });
  it('compacts text, cleans structuredContent and drops it when still large', () => {
    const out = compactResult(big);
    expect(out.content).toHaveLength(1);
    expect(out.content[0].text?.startsWith('items (25 rows):')).toBe(true);
    expect(out.structuredContent).toBeUndefined(); // 25 rows of cleaned JSON is still > COMPACT_MIN_BYTES
    const small = { content: [{ type: 'text', text: JSON.stringify({ items: issues }) }], structuredContent: { ok: true, n: null } };
    expect(compactResult(small).structuredContent).toEqual({ ok: true });
  });
  it('passes non-text blocks through', () => {
    const r = { content: [{ type: 'image', data: 'xx', mimeType: 'image/png' }, { type: 'text', text: JSON.stringify({ items: issues }) }] };
    const out = compactResult(r);
    expect(out.content[0]).toEqual(r.content[0]);
    expect(out.content).toHaveLength(2);
  });
  it('threshold constant is 2048', () => expect(COMPACT_MIN_BYTES).toBe(2048));
});
```

- [ ] **Step 2: Write failing tests for projection.ts**

```ts
// server/src/runtime/projection.test.ts
import { describe, expect, it } from 'vitest';
import { limitArrays, normalizePath, project, projectResult } from './projection.js';

const data = {
  total: 3,
  items: [
    { id: 1, title: 'a', user: { login: 'x', url: 'u1' } },
    { id: 2, title: 'b', user: { login: 'y', url: 'u2' } },
    { id: 3, title: 'c', user: { login: 'z', url: 'u3' } },
  ],
};

describe('normalizePath', () => {
  it('accepts [] and dots', () => {
    expect(normalizePath('items[].user.login')).toEqual(['items', 'user', 'login']);
    expect(normalizePath('a.b')).toEqual(['a', 'b']);
  });
});

describe('project', () => {
  it('keeps only matched paths through arrays, preserving structure', () => {
    expect(project(data, ['items.title', 'items.user.login', 'total'])).toEqual({
      matched: true,
      value: { total: 3, items: [{ title: 'a', user: { login: 'x' } }, { title: 'b', user: { login: 'y' } }, { title: 'c', user: { login: 'z' } }] },
    });
  });
  it('a path ending at an object keeps the whole object', () => {
    expect(project(data, ['items.user']).value).toEqual({ items: data.items.map((i) => ({ user: i.user })) });
  });
  it('returns the original when nothing matches', () => {
    expect(project(data, ['nope.x'])).toEqual({ matched: false, value: data });
  });
});

describe('limitArrays', () => {
  it('cuts arrays and counts omissions', () => {
    const r = limitArrays({ a: [1, 2, 3, 4], b: { c: [1, 2, 3] } }, 2);
    expect(r).toEqual({ value: { a: [1, 2], b: { c: [1, 2] } }, omitted: 3 });
  });
});

describe('projectResult', () => {
  const r = { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  it('applies owner then agent, agent cannot widen', () => {
    const out = projectResult(r, { fields: ['items.title', 'items.id'] }, { fields: ['items.title', 'items.user.login'], limit: 2 });
    expect(JSON.parse(out.content[0].text as string)).toEqual({ items: [{ title: 'a' }, { title: 'b' }] });
    expect(out.structuredContent).toEqual({ items: [{ title: 'a' }, { title: 'b' }] });
    expect(out.content[1]).toEqual({ type: 'text', text: '(_limit 2: 1 item omitted)' });
  });
  it('no match → original plus a note', () => {
    const out = projectResult(r, {}, { fields: ['zzz'] });
    expect(JSON.parse(out.content[0].text as string)).toEqual(data);
    expect(out.content[1]).toEqual({ type: 'text', text: '(_fields matched nothing: zzz)' });
  });
  it('non-JSON text: _fields ignored, _limit keeps first N lines', () => {
    const t = { content: [{ type: 'text', text: 'l1\nl2\nl3' }] };
    expect(projectResult(t, {}, { fields: ['a'], limit: 2 }).content[0].text).toBe('l1\nl2');
  });
  it('errors and empty intent pass through untouched', () => {
    const e = { ...r, isError: true };
    expect(projectResult(e, { fields: ['items.id'] }, {})).toBe(e);
    expect(projectResult(r, {}, {})).toBe(r);
  });
});
```

- [ ] **Step 3: Run to confirm they fail**

Run: `cd server && DATABASE_URL=memory: rtk proxy npx vitest run src/runtime/compact.test.ts src/runtime/projection.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement compact.ts**

Rules to encode (see spec): `cleanJson` — recursive; objects drop keys whose value is `null`/`undefined`/`''`; numbers: `Number.isInteger ? n : Number(n.toFixed(6))`; strings ≥ 200 chars matching `/^[A-Za-z0-9+/=\s]+$/` or starting with `data:` → `<base64 ${len} chars>`. `renderFlat(v, indent=0)` — object: lines `key: scalar` or `key:` + nested indented by 2; array of ≥ 3 objects with key-overlap ≥ 0.6 (|intersection of each item's keys with union| / |union| averaged) → `key (N rows):` then header `k1 | k2` (union keys in first-seen order) and rows; cells: scalars as `String`, objects/arrays as `JSON.stringify`, missing → empty; any other array → `key: ${JSON.stringify(arr)}`; top-level array → the same table/inline rule without a key prefix (`(N rows):`). `htmlToText` — regex pipeline: remove `<script|style|head>…</…>` and comments; `<a [^>]*href="(u)"[^>]*>(t)</a>` → `t (u)`; `<br>`, `</p>`, `</div>`, `</h\d>`, `</li>`, `</tr>` → `\n`; strip remaining tags; decode the six entities; collapse `[ \t]+` → ` `, trim lines, squeeze ≥ 2 blank lines to 1. `squeezeText` as the test shows. `compactText` — try `JSON.parse` → `renderFlat(cleanJson(v))`; else if `/^\s*<!doctype|^\s*<html/i` or ≥ 20 tags → `htmlToText`; else `squeezeText`; return the input when `out.length >= text.length`. `compactResult` — if `isError` or no text blocks or total text bytes < `COMPACT_MIN_BYTES` → return `r`; join text blocks with `\n`, compact; `structuredContent` → `cleanJson`, drop if `JSON.stringify(sc).length >= COMPACT_MIN_BYTES` and the text changed; return `{...r, content: [...nonText, {type:'text', text}], structuredContent}` (omit the key when dropped).

- [ ] **Step 5: Implement projection.ts**

`normalizePath` — `field.replace(/\[\]/g, '').split('.').filter(Boolean)`. `project` — build a trie from the paths; walk the value: arrays map elements; objects keep a key only if the trie has it; a trie leaf keeps the subvalue whole; `matched` becomes true when a leaf is reached on a real key. `limitArrays` — recursive, `omitted += arr.length - limit`. `projectResult` — return `r` when `isError` or (no owner fields/limit and no agent fields/limit); parse the first text block as JSON (if it fails: apply only the line-limit rule for `limit`); `owner.fields` → project; `agent.fields` → project the result (note on no match); limit = min of the defined limits; cut and note; rebuild text as `JSON.stringify(value)` (compact.ts will reformat later when enabled); apply the same to `structuredContent` when it is an object/array; notes appended as extra `{type:'text'}` blocks in the order fields-note, limit-note.

- [ ] **Step 6: Run tests, lint, commit**

Run: `cd server && DATABASE_URL=memory: rtk proxy npx vitest run src/runtime/compact.test.ts src/runtime/projection.test.ts` → PASS; `cd .. && ./node_modules/.bin/biome check --write server/src/runtime`
Commit: `feat(runtime): compact and project tool results`

---

### Task 2: schema, migration, invoker and gateway wiring

**Files:**
- Modify: `server/src/db/schema.ts` (tools: `outputFields jsonb $type<string[]>`, `outputLimit integer`; groups: `compactResults boolean notNull default true`; callLogs: `bytesIn integer`, `bytesOut integer`)
- Create: `server/drizzle/0017_compact_results.sql` + journal/snapshot via `cd server && npx drizzle-kit generate --name compact_results`
- Modify: `server/src/runtime/invoker.ts`
- Modify: `server/src/gateway/server.ts` (`AgentAuth.compactResults`, `AgentAuthAll.groups[].compactResults`, schema rewriting in both `tools/list` handlers, `compact` in both `invokeTool` calls, instructions sentence)
- Modify: `server/src/gateway/system-tools.ts` (`systemInstructions` + `system.context` `result_compaction` key)
- Modify: wherever `AgentAuth`/`AgentAuthAll` are constructed (grep `schedulingEnabled:` in `server/src/gateway/server.ts` `resolve*` and `server/src/routes/gateway.ts`) — read `groups.compactResults`.
- Test: `server/src/runtime/invoker.test.ts` (extend), `server/src/gateway/compact.integration.test.ts` (new, modelled on `isolation.integration.test.ts`)

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: `InvokeContext.compact?: boolean`; `invokeTool` strips `_fields`/`_limit`; `callLogs.bytesIn/bytesOut`; `export function withReservedArgs(schema: Record<string, unknown>): Record<string, unknown>` in `server/src/gateway/server.ts` (exported for tests); `export const COMPACTION_HINT` string in `system-tools.ts`.

- [ ] **Step 1: Schema + migration**

Add the columns; run `cd server && rtk proxy npx drizzle-kit generate --name compact_results`; check the SQL has exactly the five `ALTER TABLE … ADD COLUMN` statements (groups default `true`). Run the migration test suite: `DATABASE_URL=memory: rtk proxy npx vitest run src/db`.

- [ ] **Step 2: Failing invoker tests**

Extend `server/src/runtime/invoker.test.ts` (see how it seeds a tool and reads `callLogs`): (a) a native tool whose connector returns a 25-row JSON array (≥ 2 048 bytes) called with `{ compact: true }` returns flat-table text and logs `bytesIn > bytesOut`; (b) the same without `compact` returns the raw JSON and logs `bytesIn === bytesOut`; (c) a call with `_fields: ['items.id']` strips the arg before the connector sees it (assert the connector's received args) and returns `{"items":[{"id":…}]}`; (d) a composite whose step calls that tool, invoked with `{ compact: true }`, feeds the step raw JSON (assert the composite's output template `${$.steps.s1.text}` starts with `{"items"`); (e) a result below the threshold comes back byte-identical.

- [ ] **Step 3: Implement invoker wiring**

In `invokeTool`: `const { _fields, _limit, ...rest } = args` (validate: `_fields` array of strings, `_limit` positive integer; otherwise ignore); dispatch with `rest`; at `depth === 0 && !result.isError`: `result = projectResult(result, { fields: tool?.outputFields, limit: tool?.outputLimit }, { fields, limit })`; if `ctx.compact` → `result = compactResult(result)`; compute `bytesIn` from the raw result's text blocks (UTF-8 byte length) and `bytesOut` from the returned one; log both. Keep `args` in the error log as the original args.

- [ ] **Step 4: Failing gateway test**

`server/src/gateway/compact.integration.test.ts`: register a user, create an http source with one endpoint served by a local Fastify stub returning 25 issues, a group with the tool, an agent key; (a) `tools/list` on `/g/:slug/mcp` → the tool's `inputSchema.properties._fields` and `_limit` exist and `additionalProperties` is not `false`; (b) `tools/call` with `_fields: ['items.title']` → text is the projected table/JSON and contains no `url`; (c) `PATCH /groups/:id {compactResults:false}` then call → raw JSON text; (d) `GET /logs` row has `bytesIn`/`bytesOut`. Also unit-test `withReservedArgs` on `{type:'object', additionalProperties:false, properties:{q:{type:'string'}}}`.

- [ ] **Step 5: Implement gateway wiring**

`withReservedArgs(schema)`: if `schema.type === 'object'` (or has `properties`) → clone, add the two properties from the spec, and if `additionalProperties === false` set it to `true`; otherwise return the schema untouched. Use it in both `tools/list` handlers. Pass `compact: auth.compactResults` (group server) and `compact: auth.groups.find(g => g.id === hit.groupId)?.compactResults ?? true` (agent server). Add `compactResults` to both auth shapes and to the resolvers that build them. `systemInstructions` appends `COMPACTION_HINT` ("Results are compacted for context: JSON is rendered as key: value lines and tables. Pass _fields (dot paths, e.g. items.title) and _limit to any tool to get only what you need.") always, even when no system tools are enabled; `system.context` adds `result_compaction: COMPACTION_HINT`.

- [ ] **Step 6: Run, lint, commit**

Run: `cd server && DATABASE_URL=memory: rtk proxy npx vitest run src/runtime src/gateway src/db` → PASS; `npx tsc --noEmit -p .`; biome.
Commit: `feat(gateway): apply result compaction and projection at the agent boundary`

---

### Task 3: control-plane routes, metrics, docs

**Files:**
- Modify: `server/src/routes/tools.ts` (patchBody: `outputFields: z.array(z.string()).nullable().optional()`, `outputLimit: z.number().int().positive().nullable().optional()`)
- Modify: `server/src/routes/groups.ts` + `server/src/services/groups.ts` (`compactResults?: boolean` on create and patch)
- Modify: `server/src/routes/observability.ts` (`saved_bytes` in totals and byTool: `coalesce(sum(bytes_in - bytes_out),0)::int saved_bytes`)
- Modify: `ReadMe.md` (new section "Compact results" after "Python tools"; API lines for the new fields)
- Test: `server/src/routes/compact-routes.test.ts` (new; pattern: `server/src/routes/projects.test.ts`)

- [ ] **Step 1: Failing route tests** — PATCH `/tools/:id {outputFields:['a.b'], outputLimit: 5}` round-trips on GET; `outputLimit: 0` → 400; POST `/groups {compactResults:false}` and PATCH flip it; insert two `callLogs` rows with bytes and assert `GET /logs/metrics` `totals.saved_bytes` and `byTool[0].saved_bytes`.
- [ ] **Step 2: Implement** the three routes/services.
- [ ] **Step 3: ReadMe** — section (what level 1 does, the `_fields`/`_limit` contract with one example call, owner defaults, the workspace toggle, where savings show up, the trade-off about flat text vs JSON and that `structuredContent` stays JSON). Add `PATCH /tools/:id {outputFields, outputLimit}` and `compactResults` to the API block.
- [ ] **Step 4: Run, lint, commit** — `DATABASE_URL=memory: rtk proxy npx vitest run src/routes`; tsc; biome. Commit: `feat(api): output fields/limit, workspace compact toggle, saved bytes metrics`

---

### Task 4: admin UI

**Files:**
- Modify: `web/src/api.ts` (`Group.compactResults: boolean`; `Tool.outputFields?: string[] | null; outputLimit?: number | null`; `CallLog.bytesIn/bytesOut?: number | null`; metrics types `saved_bytes`)
- Modify: `web/src/tabs/GroupsTab.tsx` (toggle "compact" beside the scheduling toggle at the `setScheduling` pattern, PATCH `{compactResults}`)
- Modify: `web/src/tabs/ToolsTab.tsx` (`MetaForm` gains `outputFields: string` and `outputLimit: string`; inputs "Output fields (dot paths, comma-separated)" and "Output limit"; the PATCH body gets `outputFields` (split/trim/filter, `null` when empty) and `outputLimit` (`Number` or `null`); loading fills them from the tool)
- Modify: `web/src/tabs/LogsTab.tsx` (`stat('saved KB', …)` = `Math.round(saved_bytes/1024)`; per-tool column `saved KB`; log row `in→out` cell `12.3→2.1 KB` when both numbers exist, else `—`)
- Test: `web/src/tabs/GroupsTab.compact.test.tsx`, `web/src/tabs/ToolsTab.output.test.tsx`, `web/src/tabs/LogsTab.saved.test.tsx` (pattern: `web/src/tabs/AgentsTab.role.test.tsx`, `LogsTab.args.test.tsx`)

- [ ] **Step 1: Failing tests** — Groups: clicking the compact toggle PATCHes `/groups/:id {compactResults:false}`; Tools: opening a tool's metadata, typing `items.title, items.id` and `20`, saving → `api.patch` called with `outputFields:['items.title','items.id'], outputLimit:20`; Logs: totals show `saved KB`, a row with `bytesIn: 12600, bytesOut: 2100` renders `12.3→2.1 KB`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run, lint, commit** — `cd web && rtk proxy npx vitest run`; `npx tsc --noEmit -p .`; biome. Commit: `feat(web): compact toggle, output fields/limit, saved bytes`
