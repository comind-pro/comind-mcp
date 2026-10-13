# Projects — Stage 3 (Projects tab, allowlist, pending secrets) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner can see and steer everything COOs do from the admin UI: a Projects tab with the tree, per-node summary, the allowlist (grant / revoke), create child and delete; pending secrets get a badge and a value field; the header selector and badges refresh after changes.

**Architecture:** Two small server additions (`GET /projects/:id/summary`, `GET /projects/:id/access` returning resource names) and one new React page built from the existing `buildTree`, `RowBadges`, `useConfirm`, `Advanced` primitives. `ProjectsContext` gains `reload()` so the Projects tab and Agents tab can refresh the tree and agent names after a create.

**Tech Stack:** Fastify + drizzle (server bits), React 18 + vitest/jsdom + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-10-13-projects-and-coo-agents-design.md` — §6 (Projects tab, Secrets tab, Agents tab already done in Stage 2), §8 web tests.

## Global Constraints

- Server isolation rules unchanged; new routes use `scopeFor(req)` and `visibleNode`-style subtree checks; invisible → 404.
- Web: all data calls go through `api.get/post/del` (scoped) or `api.getUnscoped` (tree, agents, and the owner-wide resource lists used by the allowlist editor — those must be fetched unscoped so the owner can share from any project); native controls only; no new runtime deps.
- Biome, tsc, vitest green in both packages before each commit; commits conventional with the `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer; branch `feat/projects`.

## Review Focus

1. Deleting a node from the Projects tab must confirm and show what is lost (summary counts) — Task 2 test asserts the confirm text contains the counts.
2. Granting from the allowlist editor must offer only resources the owner has (unscoped lists) and must not list resources already in the target's own subtree — Task 2 pure-helper test.
3. A pending secret must be visibly pending and saveable in one step — Task 3 test.
4. After creating a child or a COO agent, the header selector and `by <agent>` badges reflect it without a reload — Task 1/2 `reload()` wiring; Task 2 test asserts `reload` is called after create.
5. Revoking a grant that workspaces use must warn (uses `previewRevoke` from Stage 2) — Task 2 test asserts the warning text lists the workspace.

---

### Task 1: Server — node summary and named access list

**Files:**
- Modify: `server/src/services/projects.ts` (`nodeSummary(scope, id)`, `listAccessNamed(scope, id)`), `server/src/routes/projects.ts` (`GET /projects/:id/summary`; `GET /projects/:id/access` now returns names)
- Test: `server/src/routes/projects.test.ts` (extend)

**Interfaces (Produces):**
```ts
export async function nodeSummary(scope: Scope, id: string): Promise<{ node: ProjectRow; counts: { children: number; sources: number; tools: number; groups: number; agents: number; secrets: number }; cooAgents: { id: string; name: string }[] } | null>  // subtree counts incl. the node; null when invisible
export async function listAccessNamed(scope: Scope, id: string): Promise<{ resourceType: 'source'|'tool'|'secret'; resourceId: string; name: string; fromProjectId: string; grantedBy: string | null; usedBy: { groupId: string; name: string }[] }[] | null>   // usedBy via previewRevoke's logic
```
`GET /projects/:id/access` response changes from raw rows to this named shape (the Stage 1 test asserted `resourceType`/`resourceId` only — keep those fields; add the rest).

- [ ] **Step 1:** Failing tests: summary counts for a child with one source (imported, 1 tool), one group, one agent, one secret → `{children:0, sources:1, tools:1, groups:1, agents:1, secrets:1}`; `cooAgents` lists the agent once its role is `coo` (`PATCH /agents/:id {role:'coo'}` from Stage 2); invisible node → 404. Access named: after granting a source to the child and putting its tool into a child workspace, `GET /projects/<child>/access` → one row with `name`, `fromProjectId`, `usedBy:[{name:<workspace>}]`.
- [ ] **Step 2:** Implement; PASS; full suite; biome; commit `feat(server): project node summary and named access list`.

---

### Task 2: Web — Projects tab

**Files:**
- Create: `web/src/tabs/ProjectsTab.tsx`, `web/src/tabs/projectsTab.ts` (pure helpers: `grantCandidates(all, accessRows, node, projects)` → resources not in the node's subtree and not already granted; `deleteConfirmText(summary)`; `revokeWarnText(row)`)
- Modify: `web/src/App.tsx` (new page `projects` in `PAGES` with icon `'grid'` reuse or `'folder'` if `IconName` has one — check `icons.tsx`; `ProjectsContext` gains `reload: () => Promise<void>` which refetches `/projects` and `/agents` unscoped), `web/src/ProjectSelector.tsx` (context type), `web/src/api.ts` (`ProjectSummary`, `AccessRow` types; `api.del` already exists), `web/src/tabs/AgentsTab.tsx` (call `reload()` after creating an agent or changing a role)
- Test: `web/src/tabs/projectsTab.test.ts` (pure helpers), `web/src/tabs/ProjectsTab.test.tsx` (RTL with `vi.mock('../api.js')`: renders the tree from a 3-node fixture; selecting a node shows its summary counts; "Grant" posts `{resourceType, resourceId}` to `/projects/<id>/access`; "Revoke" on a row with `usedBy` shows the warning text and calls `api.del`; "New child" posts to `/projects` and then `reload` is called; "Delete" opens the confirm with counts)

**Layout (keep it plain):** left column = the tree (indented buttons, `kind` as a `tbadge`, COO count); right column = selected node card: name/slug/kind, summary counts, `COO agents` list (name → link to Agents tab via `onNavigate`), **Allowlist** table (type, name, from project, used by workspaces, Revoke), **Share a resource** row (`<select>` type → `<select>` resource from `grantCandidates` → Grant), `+ New child` (kind select + name input), `Delete node` (danger, hidden for the default team/project).

- [ ] **Step 1:** Failing pure tests → helpers → PASS.
- [ ] **Step 2:** Failing RTL tests → component + App wiring → PASS → tsc → biome → commit `feat(web): Projects tab with tree, summary, allowlist editor`.

---

### Task 3: Web — pending secrets

**Files:**
- Modify: `web/src/tabs/SecretsTab.tsx` (when `s.pending`: `type` cell shows `<span className="badge" style={{color:'var(--warn)',borderColor:'var(--warn)'}}>pending</span>` instead of `encrypted`, and the row renders the edit input open by default with placeholder `set value`; "Save" uses the existing `PATCH /secrets/:id {value}`), `web/src/api.ts` (`Secret.pending` exists)
- Test: `web/src/tabs/SecretsTab.pending.test.tsx` (RTL with mocked `api`: a pending row shows the badge and an input; typing + Save calls `api.patch('/secrets/<id>', { value })`)

- [ ] **Step 1:** Failing test → implement → PASS → tsc → biome → commit `feat(web): pending secrets badge and inline value entry`.

---

### Task 4: Docs + final

- [ ] `ReadMe.md`: Projects tab paragraph (tree, sharing, pending secrets). Commit `docs: projects tab`.

## Self-review
- Spec §6: selector ✔ (S1), badges ✔ (S1), Projects tab ✔ T2, Secrets pending ✔ T3, Agents role ✔ (S2 T4), Activity args ✔ (S2 T4). §8 web tests ✔ T2/T3. Review Focus 1→T2 RTL delete; 2→T2 pure test; 3→T3; 4→T2 reload test; 5→T2 revoke test (needs Task 1 `usedBy`).
