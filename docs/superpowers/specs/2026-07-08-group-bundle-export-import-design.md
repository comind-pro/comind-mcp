# Group bundle export / import

Move a workspace (group) between comind instances as one JSON file: export on
dev, import on prod, fill secrets, done.

## Format — `comind bundle v1`

All references by name; no ids, no ownerId, no status/timestamps, no secret
values.

```json
{
  "version": 1,
  "group": { "slug": "polymarket", "name": "Polymarket", "description": null, "schedulingEnabled": true },
  "sources": [{ "name": "polymarket-gamma", "kind": "http", "config": { "...": "..." } }],
  "tools": [{
    "name": "polymarket-gamma.search_markets", "kind": "native",
    "source": "polymarket-gamma", "upstreamName": "search_markets",
    "displayName": null, "description": null,
    "inputSchema": null, "outputSchema": null, "visible": true,
    "readOnly": null, "dangerous": null, "permissions": [], "examples": [],
    "recommendedUse": null,
    "virtual": null, "composite": null
  }],
  "secrets": [{ "name": "TAVILY_API_KEY", "source": null }]
}
```

- `tools[].virtual` = `{ executable, request, response }` for kind=virtual.
- `tools[].composite` = the composite `definition` for kind=composite.
- `secrets[]` = names collected on export: regex `\$\{secret\.([A-Za-z0-9_.-]+)\}`
  over source configs + virtual requests, plus source-scoped secrets of the
  bundled sources. Values never leave the instance.
- Plaintext credentials typed inline into a config (not via `${secret.X}`)
  export as-is — bundle is a self-to-self artifact; documented, not scrubbed.

## Endpoints (user JWT)

- `GET /groups/:id/export` → bundle JSON.
- `POST /groups/import` (body = bundle) → report:
  `{ group, sources: {created,skipped}, tools: {created,skipped}, secrets: {created,skipped}, secretsToFill }`.

## Import semantics

- Match by name: `sources.name`, `tools.(ownerId,name)`, `groups.slug`,
  `secrets.(name, scope)`. Existing → skip and reuse (idempotent re-import).
- Secrets are created EMPTY (`encryptedValue: null, envRef: null`); user fills
  values via existing `PATCH /secrets/:id`. Existing secrets never overwritten.
- Group tools: all bundle tools (created + skipped-existing) linked via
  `groupTools` (insert missing links only).
- New ids via `newId()` everywhere; whole import in one transaction.
- Zod validation of the bundle; unknown source kinds rejected by the same
  `parseSourceConfig` used by POST /sources.

## Core fix (HttpConnector)

GET args only substitute into the `path` template; unfilled `{param}` stays
literal in the URL. Fix: after substitution drop query pairs whose value still
contains `{...}`, so optional params work. Path-segment placeholders remain
required.

## Web UI

- Group card (GroupsTab): Export button → downloads `<slug>.bundle.json`.
- Groups list header: Import button → file picker → POST → report + list of
  empty secrets to fill (link to Secrets page).

## Out of scope

- Trading execution (EIP-712 signing) — separate private service, imported
  later as an `mcp` source.
- Agents/keys/schedules are not bundled.

## Testing

- Round-trip: seed user A (http source + virtual tool + composite + group +
  secret refs) → export → import as user B → same shape, secrets empty.
- Idempotency: re-import → everything skipped, no dupes.
- HttpConnector: optional `{param}` in query dropped when arg missing.
- Live check: import the Polymarket bundle, call Gamma/Kalshi tools (public,
  keyless).
