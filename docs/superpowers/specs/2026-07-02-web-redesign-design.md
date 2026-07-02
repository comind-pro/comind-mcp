# Web UI Redesign — Design Spec

**Date:** 2026-07-02
**Branch:** `redesign/web-ui`
**Scope:** `web/` only. No server code, API contract, or README changes.

## Goal

Make the control-plane UI usable by semi-technical users (PMs, ops) — people who understand what an API key is but don't want to read JSON. Engineers keep full access to technical detail via "Advanced" sections. UX restructure + full visual refresh; API logic untouched.

## Audience & principles

- **Semi-technical default view:** happy path requires no JSON, no jargon.
- **Advanced, not amputated:** technical details (schemas, headers, raw config) live in collapsed `<details>` sections.
- **Soft renaming:** friendly screen names with the technical term as a subtitle hint. API, routes, and docs keep existing terminology.

## 1. Navigation & naming

App-shell: left sidebar (collapses to burger on mobile), content on the right. The current flow-bar with arrows is removed — the Home screen takes over its orientation role.

| Current tab | Sidebar item | Subtitle hint (page header) |
|---|---|---|
| — | Home | — |
| Sources | Connections | "sources" |
| Tools | Tools | — |
| V-MCP | Workspaces | "virtual MCP servers" |
| Agents | Agents | — |
| Secrets | Secrets | — |
| Logs | Activity | "call logs" |

Sidebar footer: account menu (email, theme toggle, log out) — replaces the current topbar user menu.

Terminology in UI copy: "composite tool" → **Recipe**; "toolset" → "tools in this workspace". Hints appear in page headers only, not in the sidebar.

## 2. Home screen

**Get-started checklist** — state derived from existing data, nothing persisted:

1. Connect a source — done when `sources.length > 0`
2. Pick tools — done when at least one visible tool exists
3. Create a workspace — done when `groups.length > 0`
4. Add an agent & get endpoint — done when `agents.length > 0`

Each step is a clickable card leading to its screen; the first incomplete step is highlighted with a "Do this" button. The checklist disappears once all four are complete.

**Post-onboarding Home:** stat cards (connections, tools, workspaces, calls last 24h — from existing observability API) + last 5 calls with a link to Activity.

**Brand-new account:** hero "Connect your first source" + single CTA.

No new endpoints; uses existing `GET /sources`, `/tools`, `/groups`, `/agents`, and observability routes.

## 3. Visual system

**Tokens:** one CSS-variable block, two themes. `:root` = light (default), `[data-theme="dark"]` = dark. Toggle in sidebar footer, stored in `localStorage`, initial value from `prefers-color-scheme`.

Semantic names only — components never reference theme-specific values: `--surface`, `--surface-raised`, `--border`, `--text`, `--text-muted`, `--accent`, `--ok`, `--err`, `--warn`.

- **Light:** `#fafafa` background, white cards, restrained blue accent, soft shadows instead of heavy borders.
- **Dark:** current palette, cleaned up and mapped onto the same semantic tokens.

**Typography:** system-ui; scale 13/14/16/20/28. Monospace reserved for keys, endpoints, and JSON — not for ordinary values.

**Component classes:** `.card`, `.badge`, `.btn` (primary/ghost/danger), `.input`, `.table`, `.empty-state`, `.modal`. Spacing scale: 4/8/12/16/24/32.

**No new dependencies.** No Tailwind, no UI kits — plain CSS with variables.

## 4. Per-screen UX

**Common to all screens:**
- Empty state with explanation + CTA (currently: bare empty tables).
- Collapsed "Advanced" `<details>` sections for JSON schemas, custom headers, raw config.
- Technical values (keys, endpoints) always get a copy button and ellipsis truncation.

**Connections (Sources):** source type chosen via cards with icon and human name — "MCP server", "REST API (OpenAPI)", "Database", "Email (IMAP)", "Google Analytics" — not an enum dropdown. Test result rendered human-readable ("Connected, found 12 tools"), not raw JSON.

**Tools:** split `ToolsTab.tsx` (1505 lines) into `ToolsList`, `ToolEditor`, `RecipeBuilder` (composite), `SchemaSection` — separate files. Tool list = table with search and per-connection filter; show/hide is an inline toggle per row.

**Workspaces:** workspace card leads with the essentials — endpoint (copy button), tool count, agents. Tool selection reuses `ToolPicker` with search.

**Agents:** after creation, a "key shown once" modal with copy button and ready-made connection snippets (Claude Desktop config / claude.ai connector URL). This is the product's most important moment — make it the most polished.

**Activity (Logs):** status as colored badges, errors expand on click, filter by workspace/agent.

**AuthPage:** same tokens, logo, single centered card.

## 5. CSS cleanup

- Rewrite `styles.css` (~1300 lines) from scratch around the tokens; dead classes are not migrated. After the rewrite, cross-check: every `className` in tsx must exist in CSS (else a bug); every CSS class must be used in tsx (else delete).
- Keep a single file (expected ~700–800 lines post-cleanup) with clear sections: tokens → base → layout → components → screens.
- Replace inline `style={{...}}` in tsx with classes, except genuine one-offs.

## 6. Verification

- `pnpm typecheck`, `pnpm lint`, existing tests — no regressions.
- Manual full-scenario pass in the browser, both themes: register → connect source → import tools → workspace → agent → key → MCP call.
- Before/after screenshots for the PR.

## Out of scope

- Server code, API contracts, route names.
- README / docs terminology (separate PR if desired).
- New onboarding wizards beyond the Home checklist (approach C was considered and rejected in favor of sidebar + Home).
