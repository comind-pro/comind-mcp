# Compact tool results — design

**Goal.** Cut the bytes a tool result costs an agent's context *in the same call*, without a second round-trip and without losing the data the agent asked for. Two levels:

1. **Auto-compaction (lossless-ish formatting)** — the gateway re-renders large results into a denser text form.
2. **Projection by intent** — the agent (per call) or the owner (per tool) says which fields and how many rows it needs; the gateway returns only that.

Both happen server-side in the gateway, so they work for every MCP client (Claude.ai, ChatGPT, Cursor, Claude Code) without hooks or installs.

Non-goals: LLM-based summarisation; storing results for later search (`result_id` handles); client-side hooks; session snapshots.

## Where it runs

`invokeTool(name, args, ctx, depth)` is the single runtime entry. Compaction and projection apply **only at depth 0** (the agent-facing call). Nested calls made by composites and Python tools (depth ≥ 1) always receive the full, untouched result — programs need the raw data.

`InvokeContext` gains `compact?: boolean` (the workspace's `compactResults` setting; the gateway sets it from the group the call came through). Scheduler/test calls leave it unset → no auto-compaction, but projection still applies (explicit intent is never ignored).

Order at depth 0:

1. Strip reserved args `_fields` and `_limit` from `args` before dispatch (upstream never sees them).
2. Dispatch → raw `CallResult`.
3. If `isError` → return as is (errors are never compacted).
4. Projection: owner `tool.outputFields` / `tool.outputLimit` first, then agent `_fields` / `_limit` (agent narrows further; it cannot widen past the owner's fields).
5. Auto-compaction when `ctx.compact === true` and the text is ≥ 2 048 bytes.
6. Call log records `bytesIn` (raw text bytes) and `bytesOut` (returned text bytes).

Compaction is skipped if the output would not be smaller than the input.

## Level 1 — auto-compaction (`server/src/runtime/compact.ts`)

Input: the concatenated `text` of the result's text blocks (and `structuredContent`, if present). Detect the shape and apply:

**JSON** (text parses as JSON object/array):
- Drop `null`, `undefined` and `""` values from objects (keep empty arrays/objects — "none" is information).
- Strings that are clearly binary — a `data:<mime>;base64,` URI, or a base64-charset string of ≥ 1 000 chars — → `<base64 N chars>`. Unquoted integers beyond 2^53 are quoted before parsing so they survive re-serialisation.
- When the rendered text is still ≥ 8 KB, one hint line is appended telling the agent to pass `_fields`/`_limit`.
- Render as **flat text**, not JSON:
  - object → `key: value` lines; nested objects indented by two spaces;
  - an array of ≥ 3 objects whose keys overlap ≥ 60 % (by the union of keys) → a table: `key (N rows)` header line, then a `|`-separated header row and one row per item; cell values that are objects/arrays are inline JSON; missing cells are empty;
  - other arrays → inline JSON on one line.
- `structuredContent`: when the tool declares an `outputSchema`, it is passed through untouched (MCP clients validate it against the schema and reject a missing or reshaped value). Otherwise it gets the same value cleanup and projection and stays JSON; if its serialised size is still ≥ 2 048 bytes after cleanup **and** text was compacted, it is dropped — the text carries the data.

**HTML** (text starts with `<!doctype`/`<html`, or contains ≥ 20 tags): drop `<script>`, `<style>`, `<head>`, comments; `<a href="u">t</a>` → `t (u)`; block tags → newlines; other tags removed; entities decoded (`&amp; &lt; &gt; &quot; &#39; &nbsp;`); whitespace collapsed; ≤ 1 blank line in a row.

**Plain text / logs** (anything else): trailing whitespace trimmed; runs of identical consecutive lines → one line + ` (×N)`; ≤ 1 blank line in a row.

Result: a single text block replaces the text blocks; non-text blocks (images, resources) pass through untouched.

## Level 2 — projection (`server/src/runtime/projection.ts`)

`project(value, fields: string[], limit?: number)` on a parsed JSON value:

- A field is a dot path: `items.title`, `data.user.email`. Arrays are traversed implicitly (`items.title` applies to every element of `items`); `items[].title` is accepted and normalised. A path ending at an object keeps the whole object.
- The output keeps only matched paths, preserving structure (`{items:[{title}]}`), key order as in the source.
- If **no** path matches anything, the original value is returned unchanged (never blank the result by mistake), and the text gets a trailing note `(_fields matched nothing: a, b)`.
- `limit`: every array longer than `limit` is cut to its first `limit` items; one trailing note `(_limit N: K items omitted)` sums the omissions. Applies to nested arrays too.
- Projection applies to both the text (parsed JSON) and `structuredContent`. Non-JSON text ignores `_fields`; `_limit` on non-JSON text keeps the first `limit` lines.

**Advertising.** Every tool in `tools/list` (group and agent servers) gains two optional properties in its `inputSchema`:

```json
"_fields": { "type": "array", "items": { "type": "string" }, "description": "Return only these dot-paths (e.g. items.title). Arrays are traversed." },
"_limit":  { "type": "integer", "description": "Keep at most N items per array." }
```

Added only when the schema is an object schema; `additionalProperties: false` is relaxed to allow them. The server `instructions` block gets one sentence: *"Results are compacted for context: JSON is rendered as key: value lines and tables. Pass `_fields` (dot paths) and `_limit` to any tool to get only what you need."* `system.context` output repeats it under a `result_compaction` key.

**Owner defaults.** `tools.outputFields: string[] | null` and `tools.outputLimit: integer | null` (PATCH `/tools/:id`). Applied before the agent's own `_fields`/`_limit`; the agent's `_fields` is resolved against the already-projected value.

## Settings and data

- `groups.compactResults boolean NOT NULL DEFAULT true` — level 1 on/off per workspace (POST/PATCH `/groups`). Level 2 is always on.
- `tools.output_fields jsonb NULL`, `tools.output_limit integer NULL`.
- `call_logs.bytes_in integer NULL`, `call_logs.bytes_out integer NULL`.
- Migration `0017_compact_results.sql` (drizzle-kit generate).
- `GET /logs/metrics`: `totals.saved_bytes = sum(bytes_in - bytes_out)`; `byTool[].saved_bytes` likewise.

## Admin UI

- **Workspaces**: a "compact results" toggle beside "scheduling" on each row (PATCH).
- **Tools**: in the metadata form, `Output fields` (comma-separated dot paths) and `Output limit` (number); saved with the rest of the metadata via PATCH `/tools/:id`.
- **Activity**: a `saved` stat (KB) in totals; a `saved` column in the per-tool table; each log row shows `in→out KB` when both are known.

## Tests

- `compact.test.ts`: JSON → flat text with table; nulls/empties dropped; base64 placeholder; HTML → text with links; logs dedupe; below-threshold untouched; error untouched; no-gain returns original; `structuredContent` dropped only when still large.
- `projection.test.ts`: dot paths through arrays; `[]` normalisation; no-match returns original + note; `_limit` with `+K more`; owner-then-agent narrowing.
- `invoker.test.ts`: depth-0 only (nested composite call sees raw JSON); reserved args stripped before dispatch; `bytesIn/bytesOut` logged.
- gateway test: `tools/list` schemas carry `_fields`/`_limit`; a call with `_fields` returns projected text.
- route tests: PATCH `/tools/:id` output fields/limit; `/groups` compactResults; metrics `saved_bytes`.
- web: Workspaces toggle PATCHes `compactResults`; Tools form sends `outputFields`/`outputLimit`; Activity renders `saved`.

## Trade-offs recorded

- Flat text instead of JSON: a programmatic (non-LLM) MCP consumer reading the *text* block of a compact-enabled workspace would need to parse the new format. `structuredContent` remains JSON; owners can switch the workspace toggle off.
- Dropping `null` loses "explicitly empty" for individual fields. Accepted; empty arrays/objects are kept.
- Two extra properties per tool in `tools/list` cost ~40 tokens per tool, recovered on the first large result.
