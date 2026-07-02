# Web UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the control-plane UI (sidebar + Home screen, light/dark themes, friendlier naming) so semi-technical users can use it, per `docs/superpowers/specs/2026-07-02-web-redesign-design.md`.

**Architecture:** Incremental migration, app stays working after every task. Task 1 introduces semantic CSS tokens + theme toggle on top of the existing variable names; Task 2 replaces the topbar/tabs shell with a sidebar; Tasks 4–10 restyle screens one by one; Task 11 purges dead CSS and inline styles. No routing library — page state stays a `useState` in `App.tsx`. No new dependencies.

**Tech Stack:** React 18 + Vite + TypeScript, plain CSS with custom properties, existing `web/src/api.ts` client. No server changes.

## Global Constraints

- **No new dependencies** — no Tailwind, no UI kits, no router.
- **No server/API changes** — `server/` is out of scope; UI renames are copy-only.
- **Renaming (UI copy only):** Sources → "Connections", V-MCP/Groups → "Workspaces", Logs → "Activity", composite tool → "Recipe". Technical term appears as a subtitle hint in page headers, not in the sidebar.
- **Themes:** `:root` = light (default), `[data-theme="dark"]` = dark. Components reference only semantic tokens (`--surface`, `--text`, …), never theme-specific values.
- **Verification:** every task verifies with `pnpm typecheck && pnpm lint` plus a browser check (`make dev`, http://localhost:5173). Existing server tests must keep passing (`pnpm test`) but should be unaffected.
- **Unit tests (web):** Task 1 adds `vitest` + `jsdom` as devDependencies of `web/` with a `test` script (`vitest run`, environment jsdom). Every task that adds or extracts pure logic (theme toggle, Home step derivation, helpers) ships a small vitest test next to the source (`*.test.ts`). UI-only styling/copy tasks need no component tests. `pnpm test` (workspace-wide) must pass at every task boundary.
- **Branch:** all work on `redesign/web-ui`. Commit after every task.
- **Monospace font** only for keys, endpoints, cron expressions, JSON — not ordinary values.
- Typography scale: 13/14/16/20/28. Spacing scale: 4/8/12/16/24/32.
- **Mobile:** single breakpoint 720px. Every screen must be usable at 360px wide: sidebar becomes a burger-toggled overlay (Task 2), tables scroll horizontally inside their `.card` (never the page body), `.row` clusters wrap, no fixed pixel widths on inputs outside Advanced blocks, modals fit `calc(100vw - 32px)`. Every task's browser check includes a pass at 375px viewport (DevTools device emulation).

---

### Task 1: Theme tokens + toggle mechanism

**Files:**
- Create: `web/src/theme.ts`
- Modify: `web/src/main.tsx`
- Modify: `web/src/styles.css` (replace the `:root` block at the top, lines 1–20)

**Interfaces:**
- Produces: `initTheme(): void`, `getTheme(): 'light' | 'dark'`, `toggleTheme(): 'light' | 'dark'` (returns the new theme) from `web/src/theme.ts`. Task 2's sidebar footer consumes `getTheme`/`toggleTheme`.
- Produces: semantic CSS tokens `--surface`, `--surface-raised`, `--surface-inset`, `--border`, `--border-strong`, `--text`, `--text-muted`, `--accent`, `--accent-soft`, `--ok`, `--err`, `--warn`, `--shadow`. Legacy names (`--bg`, `--panel`, `--panel2`, `--muted`) stay as aliases until Task 11 removes them.

- [ ] **Step 1: Create `web/src/theme.ts`**

```ts
const KEY = 'comind_theme';
export type Theme = 'light' | 'dark';

function apply(t: Theme) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem(KEY, t);
}

export function getTheme(): Theme {
  return (document.documentElement.dataset.theme as Theme) || 'light';
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'light' ? 'dark' : 'light';
  apply(next);
  return next;
}

export function initTheme(): void {
  const saved = localStorage.getItem(KEY) as Theme | null;
  apply(saved ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
}
```

- [ ] **Step 2: Call `initTheme()` in `web/src/main.tsx`**

Current file is 10 lines (React root render). Add before render:

```tsx
import { initTheme } from './theme.js';

initTheme();
```

- [ ] **Step 3: Replace the `:root` block in `web/src/styles.css`**

Replace the current `:root { --bg: #0f1216; … }` block (file top, through the font-family declaration) with:

```css
:root {
  /* light (default) */
  --surface: #fafafa;
  --surface-raised: #ffffff;
  --surface-inset: #f0f1f3;
  --border: #e4e6ea;
  --border-strong: #cdd1d8;
  --text: #1a2027;
  --text-muted: #667180;
  --accent: #2f6feb;
  --accent-soft: #e7effc;
  --ok: #1a7f37;
  --err: #cf222e;
  --warn: #9a6700;
  --shadow: 0 1px 3px rgba(20, 24, 30, 0.08);

  /* legacy aliases — removed in the final CSS purge task */
  --bg: var(--surface);
  --panel: var(--surface-raised);
  --panel2: var(--surface-inset);
  --muted: var(--text-muted);

  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  font-size: 14px;
  color-scheme: light;
}

[data-theme='dark'] {
  --surface: #0f1216;
  --surface-raised: #181d24;
  --surface-inset: #232c38;
  --border: #313d4c;
  --border-strong: #44525f;
  --text: #e6edf3;
  --text-muted: #9aa7b6;
  --accent: #4f9cf9;
  --accent-soft: #1c2a41;
  --ok: #3fb950;
  --err: #f85149;
  --warn: #d29922;
  --shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
  color-scheme: dark;
}
```

Do not touch the rest of the file yet — legacy aliases keep every existing rule working.

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.
Browser: `make dev`, open http://localhost:5173 — app renders in **light** theme (colors will look rough on unmigrated screens; acceptable until Task 11). In DevTools run `document.documentElement.dataset.theme = 'dark'` — dark palette returns.

- [ ] **Step 5: Commit**

```bash
git add web/src/theme.ts web/src/main.tsx web/src/styles.css
git commit -m "feat(web): light/dark theme tokens with localStorage toggle"
```

---

### Task 2: App shell — sidebar, renames, page headers

**Files:**
- Modify: `web/src/App.tsx` (full rewrite, currently 114 lines)
- Modify: `web/src/styles.css` (remove `.topbar/.tabs/.tab/.flow/.step/.arrow/.topbar-sep/.user-menu/.menu-pop/.menu-email/.menu-item` rules; add sidebar rules)

**Interfaces:**
- Consumes: `getTheme`, `toggleTheme` from `web/src/theme.ts` (Task 1).
- Produces: `PAGES` config and page-id union `'home' | 'connections' | 'tools' | 'workspaces' | 'agents' | 'secrets' | 'activity'`. Task 4 plugs `<Home onNavigate={setPage} />` into the `home` case; until then `home` renders a placeholder.
- Produces: layout classes `.shell`, `.sidebar`, `.side-item`, `.side-foot`, `.main`, `.page-title`, `.page-hint` used by all later tasks.

- [ ] **Step 1: Rewrite `web/src/App.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { AuthPage } from './AuthPage.js';
import { type AuthUser, api, tokenStore } from './api.js';
import { getTheme, toggleTheme } from './theme.js';
import { AgentsTab } from './tabs/AgentsTab.js';
import { GroupsTab } from './tabs/GroupsTab.js';
import { LogsTab } from './tabs/LogsTab.js';
import { SecretsTab } from './tabs/SecretsTab.js';
import { SourcesTab } from './tabs/SourcesTab.js';
import { ToolsTab } from './tabs/ToolsTab.js';

export type PageId = 'home' | 'connections' | 'tools' | 'workspaces' | 'agents' | 'secrets' | 'activity';

const PAGES: { id: PageId; label: string; hint: string | null; icon: string }[] = [
  { id: 'home', label: 'Home', hint: null, icon: '⌂' },
  { id: 'connections', label: 'Connections', hint: 'sources', icon: '⇄' },
  { id: 'tools', label: 'Tools', hint: null, icon: '⚒' },
  { id: 'workspaces', label: 'Workspaces', hint: 'virtual MCP servers', icon: '▦' },
  { id: 'agents', label: 'Agents', hint: null, icon: '◉' },
  { id: 'secrets', label: 'Secrets', hint: null, icon: '🔒' },
  { id: 'activity', label: 'Activity', hint: 'call logs', icon: '≡' },
];

export function App() {
  const [page, setPage] = useState<PageId>('home');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState(getTheme());
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    const drop = () => setUser(null);
    window.addEventListener('comind-unauthorized', drop);
    if (tokenStore.get()) {
      api
        .me()
        .then(setUser)
        .catch(() => setUser(null))
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
    return () => window.removeEventListener('comind-unauthorized', drop);
  }, []);

  const logout = () => {
    api.logout();
    setUser(null);
  };

  if (loading) return <div className="page-loading text-muted">Loading…</div>;
  if (!user) return <AuthPage onAuth={setUser} />;

  const current = PAGES.find((p) => p.id === page) ?? PAGES[0];

  return (
    <div className="shell">
      <button className="nav-burger" onClick={() => setNavOpen(!navOpen)} aria-label="Menu">
        ☰
      </button>
      <aside className={`sidebar ${navOpen ? 'open' : ''}`}>
        <div className="side-brand">comind</div>
        <nav>
          {PAGES.map((p) => (
            <button
              key={p.id}
              className={`side-item ${p.id === page ? 'active' : ''}`}
              onClick={() => {
                setPage(p.id);
                setNavOpen(false);
              }}
            >
              <span className="side-icon">{p.icon}</span>
              {p.label}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <button className="side-item" onClick={() => setTheme(toggleTheme())}>
            <span className="side-icon">{theme === 'light' ? '☾' : '☀'}</span>
            {theme === 'light' ? 'Dark mode' : 'Light mode'}
          </button>
          <div className="side-user" title={user.email}>
            <span className="side-user-email">{user.email}</span>
            <button className="side-logout" onClick={logout}>
              Log out
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="page-head-shell">
          <h1 className="page-title">{current.label}</h1>
          {current.hint && <span className="page-hint">{current.hint}</span>}
        </header>
        {page === 'home' && <div className="text-muted">Home — coming in the next task.</div>}
        {page === 'connections' && <SourcesTab />}
        {page === 'tools' && <ToolsTab />}
        {page === 'workspaces' && <GroupsTab />}
        {page === 'agents' && <AgentsTab />}
        {page === 'secrets' && <SecretsTab />}
        {page === 'activity' && <LogsTab />}
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Update `web/src/styles.css`**

Delete rules: `.topbar`, `.brand` (topbar variant only — `AuthPage` uses `.brand` too, keep a minimal `.brand { font-weight: 600; }`), `.tabs`, `.tab`, `.tab:hover`, `.tab.active`, `.topbar-sep`, `.user-menu`, `.menu-pop`, `.menu-email`, `.menu-item`, `.flow`, `.step`, `.arrow` (keep `.arrow` if the landing page uses it — it does, in `.landing-flow`; scope deletion to the flow-bar rule only if shared).

Add:

```css
.shell {
  display: flex;
  min-height: 100vh;
}
.sidebar {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 16px 12px;
  background: var(--surface-raised);
  border-right: 1px solid var(--border);
  position: sticky;
  top: 0;
  height: 100vh;
}
.side-brand {
  font-weight: 700;
  font-size: 16px;
  padding: 4px 10px 16px;
}
.side-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: none;
  color: var(--text-muted);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
}
.side-item:hover {
  background: var(--surface-inset);
  color: var(--text);
}
.side-item.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.side-icon {
  width: 18px;
  text-align: center;
}
.side-foot {
  margin-top: auto;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
.side-user {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px 0;
  font-size: 13px;
}
.side-user-email {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
}
.side-logout {
  border: none;
  background: none;
  color: var(--accent);
  cursor: pointer;
  font-size: 13px;
  padding: 0;
}
.main {
  flex: 1;
  min-width: 0;
  padding: 24px 32px 48px;
  max-width: 1100px;
}
.page-head-shell {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 20px;
}
.page-title {
  font-size: 28px;
  font-weight: 700;
  margin: 0;
}
.page-hint {
  color: var(--text-muted);
  font-size: 13px;
}
.page-loading {
  padding: 40px;
}
.text-muted {
  color: var(--text-muted);
}
.nav-burger {
  display: none;
}
@media (max-width: 720px) {
  .nav-burger {
    display: block;
    position: fixed;
    top: 10px;
    left: 10px;
    z-index: 20;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-raised);
    color: var(--text);
    padding: 6px 10px;
    cursor: pointer;
  }
  .sidebar {
    position: fixed;
    left: 0;
    top: 0;
    z-index: 10;
    transform: translateX(-100%);
    transition: transform 0.15s ease;
  }
  .sidebar.open {
    transform: translateX(0);
  }
  .main {
    padding: 56px 16px 32px;
  }
}
```

Also delete the old `.wrap` rule; `.main` replaces it.

- [ ] **Step 3: Remove per-screen duplicate `.page-head` titles**

Each tab currently renders its own `.page-head` with a `.title` ("Agents", "V-MCP", "Logs", "Secrets"). The shell header now owns the title. In this task only neutralize the duplication minimally: in each tab (`AgentsTab.tsx:418`, `GroupsTab.tsx:191`, `LogsTab.tsx:61`, `SecretsTab.tsx:70`), remove the `<span className="title">…</span>` element and keep the counts/actions row. Full restyle of each screen comes in its own task.

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.
Browser: sidebar on the left with 7 items, renamed labels, hints in page headers ("Workspaces — virtual MCP servers"), theme toggle works and persists on reload, mobile burger at ≤720px, all six existing screens still function.

- [ ] **Step 5: Commit**

```bash
git add web/src/App.tsx web/src/styles.css web/src/tabs/AgentsTab.tsx web/src/tabs/GroupsTab.tsx web/src/tabs/LogsTab.tsx web/src/tabs/SecretsTab.tsx
git commit -m "feat(web): sidebar app shell with friendly page names and theme toggle"
```

---

### Task 3: Shared UI primitives

**Files:**
- Create: `web/src/ui.tsx`
- Modify: `web/src/styles.css` (add `.copy-row`, `.empty-state`, `.advanced` rules)
- Modify: `web/src/tabs/AgentsTab.tsx` (replace local `Snip` with `CopyRow`)

**Interfaces:**
- Produces:
  - `CopyRow({ text, label }: { text: string; label?: string })` — monospace value + Copy button ("Copied" flash). Replaces `Snip` in `AgentsTab.tsx:4-25`.
  - `EmptyState({ title, body, actionLabel, onAction }: { title: string; body: string; actionLabel?: string; onAction?: () => void })`.
  - `Advanced({ summary = 'Advanced', children }: { summary?: string; children: ReactNode })` — collapsed `<details>`.

- [ ] **Step 1: Create `web/src/ui.tsx`**

```tsx
import { type ReactNode, useState } from 'react';

export function CopyRow({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <div>
      {label && <div className="field-label">{label}</div>}
      <div className="copy-row">
        <div className="copy-row-text mono">{text}</div>
        <button className="ghost" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state-title">{title}</div>
      <div className="empty-state-body">{body}</div>
      {actionLabel && onAction && (
        <button className="btn-primary" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export function Advanced({ summary = 'Advanced', children }: { summary?: string; children: ReactNode }) {
  return (
    <details className="advanced">
      <summary>{summary}</summary>
      <div className="advanced-body">{children}</div>
    </details>
  );
}
```

- [ ] **Step 2: Add CSS**

```css
.copy-row {
  display: flex;
  align-items: stretch;
  gap: 6px;
  margin-bottom: 8px;
}
.copy-row-text {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  font-size: 12.5px;
  background: var(--surface-inset);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
.empty-state {
  text-align: center;
  padding: 48px 24px;
  border: 1px dashed var(--border-strong);
  border-radius: 12px;
  margin-top: 8px;
}
.empty-state-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 6px;
}
.empty-state-body {
  color: var(--text-muted);
  max-width: 440px;
  margin: 0 auto 16px;
}
.advanced {
  margin: 12px 0;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.advanced > summary {
  cursor: pointer;
  padding: 8px 12px;
  color: var(--text-muted);
  font-size: 13px;
  user-select: none;
}
.advanced-body {
  padding: 4px 12px 12px;
}
```

- [ ] **Step 3: Replace `Snip` in `AgentsTab.tsx`**

Delete the local `Snip` component (lines 4–25). Replace its three usages (`<Snip text={ep} />`, the `claude mcp add …` snippet, the `curl` snippet) with `<CopyRow text={…} />`. Add `import { CopyRow } from '../ui.js';`.

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS. Browser: Agents → open agent → endpoint/snippets render with Copy buttons.

- [ ] **Step 5: Commit**

```bash
git add web/src/ui.tsx web/src/styles.css web/src/tabs/AgentsTab.tsx
git commit -m "feat(web): shared CopyRow, EmptyState, Advanced primitives"
```

---

### Task 4: Home screen

**Files:**
- Create: `web/src/Home.tsx`
- Modify: `web/src/App.tsx` (replace the `home` placeholder)
- Modify: `web/src/styles.css` (checklist + stat cards)

**Interfaces:**
- Consumes: `api` from `./api.js`; `PageId` from `./App.js`; `EmptyState` not needed here (custom hero).
- Produces: `Home({ onNavigate }: { onNavigate: (p: PageId) => void })`.
- Endpoints used (all exist): `GET /sources`, `GET /tools`, `GET /groups`, `GET /agents`, `GET /metrics?from=<24h-ago ISO>`, `GET /logs?limit=5`.

- [ ] **Step 1: Create `web/src/Home.tsx`**

```tsx
import { useEffect, useState } from 'react';
import type { PageId } from './App.js';
import { type Agent, api, type CallLog, type Group, type Source, type Tool } from './api.js';

interface Totals {
  calls: number;
  errors: number;
}

interface StepDef {
  label: string;
  body: string;
  page: PageId;
  done: boolean;
}

export function Home({ onNavigate }: { onNavigate: (p: PageId) => void }) {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [recent, setRecent] = useState<CallLog[]>([]);

  useEffect(() => {
    void api.get<Source[]>('/sources').then(setSources);
    void api.get<Tool[]>('/tools').then(setTools);
    void api.get<Group[]>('/groups').then(setGroups);
    void api.get<Agent[]>('/agents').then(setAgents);
    const from = new Date(Date.now() - 86_400_000).toISOString();
    void api.get<{ totals: Totals }>(`/metrics?from=${encodeURIComponent(from)}`).then((m) => setTotals(m.totals));
    void api.get<CallLog[]>('/logs?limit=5').then(setRecent);
  }, []);

  if (!sources || !tools || !groups || !agents) return <div className="text-muted">Loading…</div>;

  const steps: StepDef[] = [
    {
      label: 'Connect a source',
      body: 'Link an MCP server, REST API, database, or email account.',
      page: 'connections',
      done: sources.length > 0,
    },
    {
      label: 'Import tools',
      body: 'Pull in the actions your connection offers and curate them.',
      page: 'tools',
      done: tools.length > 0,
    },
    {
      label: 'Create a workspace',
      body: 'Bundle chosen tools into one endpoint for your agent.',
      page: 'workspaces',
      done: groups.length > 0,
    },
    {
      label: 'Add an agent & get its key',
      body: 'Create an agent, grant it the workspace, copy its key.',
      page: 'agents',
      done: agents.length > 0,
    },
  ];
  const allDone = steps.every((s) => s.done);
  const firstOpen = steps.findIndex((s) => !s.done);

  if (!sources.length) {
    return (
      <div className="home-hero">
        <h2>Connect your first source</h2>
        <p className="text-muted">
          A source is anything your agents should be able to use — an MCP server, a REST API, a database, or an email
          account. Everything else builds on it.
        </p>
        <button className="btn-primary" onClick={() => onNavigate('connections')}>
          Connect a source
        </button>
      </div>
    );
  }

  return (
    <>
      {!allDone && (
        <div className="home-steps">
          {steps.map((s, i) => (
            <button
              key={s.page}
              className={`home-step ${s.done ? 'done' : ''} ${i === firstOpen ? 'next' : ''}`}
              onClick={() => onNavigate(s.page)}
            >
              <span className="home-step-mark">{s.done ? '✓' : i + 1}</span>
              <span>
                <span className="home-step-label">{s.label}</span>
                <span className="home-step-body">{s.body}</span>
              </span>
              {i === firstOpen && <span className="home-step-cta">Do this →</span>}
            </button>
          ))}
        </div>
      )}

      <div className="home-stats">
        <StatCard value={sources.length} label="connections" onClick={() => onNavigate('connections')} />
        <StatCard value={tools.length} label="tools" onClick={() => onNavigate('tools')} />
        <StatCard value={groups.length} label="workspaces" onClick={() => onNavigate('workspaces')} />
        <StatCard
          value={totals ? `${totals.calls}` : '…'}
          label={`calls · 24h${totals && totals.errors ? ` (${totals.errors} errors)` : ''}`}
          onClick={() => onNavigate('activity')}
        />
      </div>

      {recent.length > 0 && (
        <div className="card">
          <h2>Recent calls</h2>
          <table>
            <tbody>
              {recent.map((l) => (
                <tr key={l.id}>
                  <td className="text-muted">{new Date(l.ts).toLocaleString()}</td>
                  <td className="mono">{l.toolName}</td>
                  <td>
                    <span className={`badge ${l.status === 'success' ? 'ok' : 'err'}`}>{l.status}</span>
                  </td>
                  <td>{l.durationMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="ghost" onClick={() => onNavigate('activity')}>
            View all activity →
          </button>
        </div>
      )}
    </>
  );
}

function StatCard({ value, label, onClick }: { value: number | string; label: string; onClick: () => void }) {
  return (
    <button className="stat-card" onClick={onClick}>
      <span className="stat-card-v">{value}</span>
      <span className="stat-card-l">{label}</span>
    </button>
  );
}
```

- [ ] **Step 2: Wire into `App.tsx`**

Replace `{page === 'home' && <div className="text-muted">Home — coming in the next task.</div>}` with `{page === 'home' && <Home onNavigate={setPage} />}` and add `import { Home } from './Home.js';`.

- [ ] **Step 3: Add CSS**

```css
.home-hero {
  text-align: center;
  padding: 80px 24px;
}
.home-hero h2 {
  font-size: 28px;
  margin: 0 0 8px;
}
.home-hero p {
  max-width: 480px;
  margin: 0 auto 20px;
}
.home-steps {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 24px;
}
.home-step {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-raised);
  color: var(--text);
  text-align: left;
  cursor: pointer;
  box-shadow: var(--shadow);
}
.home-step.done {
  opacity: 0.6;
}
.home-step.next {
  border-color: var(--accent);
}
.home-step-mark {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--surface-inset);
  font-weight: 600;
}
.home-step.done .home-step-mark {
  background: var(--ok);
  color: #fff;
}
.home-step-label {
  display: block;
  font-weight: 600;
}
.home-step-body {
  display: block;
  color: var(--text-muted);
  font-size: 13px;
}
.home-step-cta {
  margin-left: auto;
  color: var(--accent);
  font-weight: 600;
  white-space: nowrap;
}
.home-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 24px;
}
.stat-card {
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-raised);
  color: var(--text);
  cursor: pointer;
  text-align: left;
  box-shadow: var(--shadow);
}
.stat-card-v {
  display: block;
  font-size: 28px;
  font-weight: 700;
}
.stat-card-l {
  color: var(--text-muted);
  font-size: 13px;
}
```

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS. Browser: fresh account → hero; account with sources → checklist with correct done-marks, first open step highlighted; all four done → checklist hidden, stats + recent calls shown; every card navigates.

- [ ] **Step 5: Commit**

```bash
git add web/src/Home.tsx web/src/App.tsx web/src/styles.css
git commit -m "feat(web): Home screen with get-started checklist and stat cards"
```

---

### Task 5: Connections (Sources) screen

**Files:**
- Modify: `web/src/tabs/SourcesTab.tsx`
- Modify: `web/src/tabs/SourceFields.tsx` (only if kind-picker markup lives there — the kind selector is in `SourcesTab`)
- Modify: `web/src/styles.css` (`.kind-cards`, `.kind-card`)

**Interfaces:**
- Consumes: `KIND_META`, `DEFAULTS`, `Kind` from `./SourceFields.js` (already exported); `EmptyState` from `../ui.js`.

- [ ] **Step 1: Kind picker → cards**

In the new-source editor, replace the current kind `<select>`/segment control with a card grid rendered from `KIND_META` (only when `ed.id === 'new'`; kind is immutable for an existing source):

```tsx
<div className="kind-cards">
  {KINDS.map((k) => (
    <button
      key={k}
      className={`kind-card ${ed.kind === k ? 'active' : ''}`}
      onClick={() => patch({ kind: k, cfg: DEFAULTS[k], jsonRaw: null, jsonError: null, testState: 'idle' })}
    >
      <span className="kind-card-title">{KIND_META[k].title}</span>
      <span className="kind-card-desc">{KIND_META[k].desc}</span>
    </button>
  ))}
</div>
```

CSS:

```css
.kind-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px;
  margin-bottom: 14px;
}
.kind-card {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-raised);
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.kind-card.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.kind-card-title {
  display: block;
  font-weight: 600;
  font-size: 13.5px;
}
.kind-card-desc {
  display: block;
  color: var(--text-muted);
  font-size: 12px;
}
```

- [ ] **Step 2: Human-readable test result**

Where the test result renders (driven by `ed.testState`/`ed.testMsg`), show a sentence instead of raw payload: on `ok` — `✓ Connected` (append tool count if the test response includes one); on `error` — `Couldn't connect: <message>` in `.err-msg`. Keep the raw server message inside an `<Advanced summary="Details">` block when it is longer than one line.

- [ ] **Step 3: JSON config pane → Advanced**

The two-way JSON editor pane (`onJson`, `jsonRaw`) moves inside `<Advanced summary="Raw JSON config">…</Advanced>`. Form fields stay primary.

- [ ] **Step 4: Empty state + intro copy**

Replace the bottom "No sources yet."-style block with:

```tsx
<EmptyState
  title="No connections yet"
  body="Connect an MCP server, REST API, database, or email account — comind will list every tool it offers."
  actionLabel="+ New connection"
  onAction={openNew}
/>
```

Rename visible copy in this file: "New source" button → "New connection"; `.intro` paragraph rewritten to one plain sentence: "Connections are the upstream systems your tools come from. Add one, test it, then import its tools." Keep the word "sources" out of body copy (page hint already shows it).

- [ ] **Step 5: Verify**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS. Browser: create each kind via cards, test a source, import tools; raw JSON reachable under Advanced.

- [ ] **Step 6: Commit**

```bash
git add web/src/tabs/SourcesTab.tsx web/src/tabs/SourceFields.tsx web/src/styles.css
git commit -m "feat(web): connections screen — kind cards, human test results, advanced JSON"
```

---

### Task 6: Tools screen — split ToolsTab + restyle

**Files:**
- Create: `web/src/tabs/ToolEditor.tsx`
- Modify: `web/src/tabs/ToolsTab.tsx` (1505 → ~400 lines: state + list)
- Modify: `web/src/tabs/CompositeBuilder.tsx` (UI copy only: "composite" → "Recipe")
- Modify: `web/src/styles.css`

**Interfaces:**
- Produces: `ToolEditor` component in `ToolEditor.tsx` with props:

```tsx
export interface ToolEditorProps {
  ed: Editing;                         // move the Editing/MetaForm/VReq/Step/RunResult/StepTrace/Cfg types to ToolEditor.tsx and export Editing
  tools: Tool[];
  sources: Source[];
  patch: (p: Partial<Editing>) => void;
  setMeta: (p: Partial<MetaForm>) => void;
  onSave: () => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
}
```

- Consumes: `Editing` type re-imported by `ToolsTab.tsx` from `./ToolEditor.js`.

- [ ] **Step 1: Mechanical extraction**

Move from `ToolsTab.tsx` to `ToolEditor.tsx`, verbatim: the type declarations (`StepTrace`, `RunResult`, `Cfg`, `Step`, `MetaForm`, `VReq`, `Editing`, lines 6–73) and the entire editor JSX + its local helpers (everything that renders when `ed !== null` — the editor panel, schema forms, test runner, JSON override pane, step picker). `ToolsTab.tsx` keeps: data loading, search/filter state, the list rendering, `ed` state + `patch`/`setMeta`/`close`/save/delete handlers (they call `api`, stay near the data), and renders `<ToolEditor ed={ed} … />`. Export `Editing` and `MetaForm` from `ToolEditor.tsx`; import them in `ToolsTab.tsx`. No behavior change — this step is only a file move; verify with typecheck before touching styling.

- [ ] **Step 2: List → table with inline visibility toggle**

Replace the current list cards with a `.card` table: columns Name (displayName, `.mono` internal name under it in 12px muted), Connection (source name badge), Kind badge (`native` / `Recipe` / `virtual`), Visible (checkbox toggling `PATCH /tools/:id {visible}` immediately), Edit button opening the editor. Keep existing search input and source filter; kind filter labels become "All / Native / Recipes / Virtual".

- [ ] **Step 3: Copy renames**

In `ToolsTab.tsx` and `CompositeBuilder.tsx` UI strings only: "composite" → "Recipe" ("New composite" → "New recipe", kind badge, intro text). Internal `kind === 'composite'` values untouched. `.intro` paragraph: "Tools are the individual actions agents can call. Hide the noisy ones, rename the cryptic ones, or combine several into a recipe."

- [ ] **Step 4: Advanced sections in editor**

Inside `ToolEditor.tsx`: wrap the JSON override pane and the metadata block (`MetaForm`: readOnly/dangerous/permissions/examples) each in `<Advanced summary="Raw JSON">` / `<Advanced summary="Metadata & examples">`. Schema builder and test runner stay visible (core actions).

- [ ] **Step 5: Empty state**

Add a prop to `ToolsTab`: `export function ToolsTab({ onNavigate }: { onNavigate: (p: PageId) => void })` (import `PageId` from `../App.js`), and in `App.tsx` render `<ToolsTab onNavigate={setPage} />`. Then:

```tsx
<EmptyState
  title="No tools yet"
  body="Tools appear here after you import them from a connection."
  actionLabel="Go to Connections"
  onAction={() => onNavigate('connections')}
/>
```

- [ ] **Step 6: Verify**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS. Browser: list renders, search/filters work, visibility toggle persists, editor opens/saves/tests/deletes, recipe creation works end-to-end.

- [ ] **Step 7: Commit**

```bash
git add web/src/tabs/ToolsTab.tsx web/src/tabs/ToolEditor.tsx web/src/tabs/CompositeBuilder.tsx web/src/App.tsx web/src/styles.css
git commit -m "refactor(web): split ToolEditor out of ToolsTab; tools table with inline visibility"
```

---

### Task 7: Workspaces (Groups) screen

**Files:**
- Modify: `web/src/tabs/GroupsTab.tsx`
- Modify: `web/src/styles.css` (if needed — reuse `.scard` styles)

**Interfaces:**
- Consumes: `CopyRow`, `EmptyState` from `../ui.js`.

- [ ] **Step 1: Copy renames**

All UI strings in `GroupsTab.tsx`: "V-MCP" → "workspace"/"Workspace". Specifically: intro paragraph → "A workspace bundles chosen tools into one endpoint you hand to an agent. Different agents can get different workspaces."; "+ New V-MCP" → "+ New workspace"; delete confirm → `Delete workspace "${g.name}"? Its agent grants and schedules will be removed too.`; "Delete V-MCP" button → "Delete workspace"; "No V-MCP servers yet." → replaced by `EmptyState` in Step 3. "Save toolset (N)" → "Save tools (N)"; section header "Toolset" → "Tools in this workspace".

- [ ] **Step 2: Endpoint first-class**

At the top of the open card body, replace the endpoint hint (`GroupsTab.tsx:101-104`) with:

```tsx
<CopyRow label="MCP endpoint" text={`${api.base}/g/${g.slug}/mcp`} />
<div className="hint">Connect it from the Agents page — the agent's key authorizes this endpoint.</div>
```

(`api` already imported.)

- [ ] **Step 3: Empty state**

```tsx
<EmptyState
  title="No workspaces yet"
  body="A workspace turns your curated tools into a single endpoint for an agent."
  actionLabel="+ New workspace"
  onAction={() => setDraft('')}
/>
```

- [ ] **Step 4: Schedules copy**

Section header "Schedules" stays; hint becomes "Run a tool automatically on a cron schedule. Connected agents can also schedule themselves." Cron input keeps `.mono`.

- [ ] **Step 5: Verify**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS. Browser: create workspace, assign tools, save, add/run/delete schedule, delete workspace.

- [ ] **Step 6: Commit**

```bash
git add web/src/tabs/GroupsTab.tsx web/src/styles.css
git commit -m "feat(web): workspaces screen — friendly copy, prominent endpoint, empty state"
```

---

### Task 8: Agents screen — key-once modal + renames

**Files:**
- Modify: `web/src/tabs/AgentsTab.tsx`
- Modify: `web/src/styles.css` (`.modal-overlay`, `.modal`)

**Interfaces:**
- Consumes: `CopyRow`, `EmptyState`, `Advanced` from `../ui.js`.
- Produces: local `KeyModal` component in `AgentsTab.tsx` (not exported).

- [ ] **Step 1: Modal CSS**

```css
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 18, 22, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal {
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 24px;
  width: min(560px, calc(100vw - 32px));
  max-height: 85vh;
  overflow-y: auto;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
}
.modal h3 {
  margin: 0 0 4px;
}
```

- [ ] **Step 2: `KeyModal` component (local to `AgentsTab.tsx`)**

Shown when a fresh key is created (`create` and `addKey` paths set `modalKey`). Replaces the inline green `freshKeys` row as the *primary* reveal (keep the inline row too — the modal can be dismissed, and until reload the key remains visible in the list, matching current behavior).

```tsx
function KeyModal({ agent, apiKey, onClose }: { agent: Agent; apiKey: string; onClose: () => void }) {
  const ep = `${api.base}/a/mcp`;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>API key for “{agent.name}”</h3>
        <div className="hint">This key is shown once. Copy it now — you can always create another one later.</div>
        <CopyRow label="API key" text={apiKey} />
        <CopyRow label="MCP endpoint" text={ep} />
        <CopyRow
          label="Claude Code / Cursor / any MCP client"
          text={`claude mcp add ${agent.name.replace(/\s+/g, '-')} --transport http ${ep} --header "Authorization: Bearer ${apiKey}"`}
        />
        <div className="hint">
          For claude.ai or ChatGPT: add the endpoint as a custom connector and paste the key when asked.
        </div>
        <button className="btn-primary" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
```

State: `const [modalKey, setModalKey] = useState<{ agent: Agent; apiKey: string } | null>(null);` — set in `create` (with the returned `a.apiKey`) and `addKey` (fetch the agent from state by id). Render `{modalKey && <KeyModal {...modalKey} onClose={() => setModalKey(null)} />}` at component root.

- [ ] **Step 3: Copy renames**

"V-MCP access" → "Workspace access"; "All V-MCPs" / "Single V-MCP" segment → "All workspaces" / "One workspace"; "— grant V-MCP access —" → "— grant workspace access —"; intro → "An agent is anything that connects from outside — Claude, ChatGPT, a script. Each agent gets its own key and sees only the workspaces you grant it."; "no access" list hint stays. System-tools section: wrap the whole block (checkboxes + examples) in `<Advanced summary="System tools (introspection)">` — it's expert territory.

- [ ] **Step 4: Empty state**

```tsx
<EmptyState
  title="No agents yet"
  body="Create an agent to get an API key and an endpoint you can plug into Claude, ChatGPT, or any MCP client."
  actionLabel="+ New agent"
  onAction={() => setDraft('')}
/>
```

- [ ] **Step 5: Verify**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS. Browser: create agent → modal appears with key + snippets, copy works, dismiss; "+ Add key" also opens modal; grants/revokes/inspect unaffected.

- [ ] **Step 6: Commit**

```bash
git add web/src/tabs/AgentsTab.tsx web/src/styles.css
git commit -m "feat(web): agents screen — key-once modal with connection snippets"
```

---

### Task 9: Secrets + Activity screens

**Files:**
- Modify: `web/src/tabs/SecretsTab.tsx`
- Modify: `web/src/tabs/LogsTab.tsx`

**Interfaces:**
- Consumes: `EmptyState`, `Advanced` from `../ui.js`.

- [ ] **Step 1: Secrets copy + empty state**

Intro → "Secrets hold tokens and passwords your connections need. They're stored encrypted; agents never see them." Move the `${secret.NAME}` reference explanation into the create form hint (already there) and wrap the env-var mode explainer in plain words: `value (encrypt)` option label → "Paste a value (stored encrypted)"; `envRef (env variable)` → "Reference a server env variable". Table "No secrets yet." row → `EmptyState` with action opening the draft form.

- [ ] **Step 2: Activity copy + expandable errors + workspace/agent filters**

Intro → "Every tool call your agents make lands here — what ran, how long it took, and whether it worked." Filters: source segment labels "all / live / test / scheduled". Add two `<select>` filters — Workspace and Agent — feeding the existing `groupId`/`agentId` query params of `GET /logs` (options loaded via `GET /groups` and `GET /agents`; empty option = all). Metrics (`GET /metrics`) don't support these params — leave metrics unfiltered and only filter the calls table. Errors: make each error-status row clickable, expanding a detail row underneath. `GET /logs` rows don't currently carry an error message field — check `CallLog`; it doesn't. So: expandable row shows tool, agent id, source, exact timestamp, duration — no fake fields. Skip fetch-on-expand (no endpoint for single-log detail; do not invent one).

- [ ] **Step 3: Empty states**

Logs "No calls logged yet." → `EmptyState { title: "No activity yet", body: "Calls appear here as soon as an agent (or a schedule) runs a tool." }` — no action button.

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS. Browser: both screens render with data and empty, filters work.

- [ ] **Step 5: Commit**

```bash
git add web/src/tabs/SecretsTab.tsx web/src/tabs/LogsTab.tsx
git commit -m "feat(web): secrets and activity screens — plain-language copy, empty states"
```

---

### Task 10: AuthPage restyle

**Files:**
- Modify: `web/src/AuthPage.tsx` (minor)
- Modify: `web/src/styles.css` (landing rules → tokens)

- [ ] **Step 1: Token audit of landing CSS**

All `.landing-*`, `.shot-*` rules in `styles.css` currently reference dark-theme values. Re-express them with semantic tokens so the landing looks right in both themes (it renders before login, theme = system preference). Keep layout as-is.

- [ ] **Step 2: Copy tweak**

In `AuthPage.tsx` STEPS array: "Build a V-MCP" → "Build a workspace" with body "Bundle the curated tools into a workspace — a single clean endpoint that hides the messy upstreams."; VmcpShot title "V-MCP · support-bot" → "Workspace · support-bot"; "shape them into a clean V-MCP" → "shape them into a clean workspace". Inline styles on the form inputs/buttons replaced with a `.auth-form` class block.

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS. Browser (logged out): landing renders correctly in light and dark (`prefers-color-scheme` emulation in DevTools), login and register flows work.

- [ ] **Step 4: Commit**

```bash
git add web/src/AuthPage.tsx web/src/styles.css
git commit -m "feat(web): auth landing on theme tokens, workspace wording"
```

---

### Task 11: CSS purge + inline-style sweep

**Files:**
- Modify: `web/src/styles.css` (reorganize + delete dead rules + drop legacy aliases)
- Modify: any `web/src/**/*.tsx` still carrying replaceable inline styles

- [ ] **Step 1: Replace legacy variable references**

```bash
grep -rn 'var(--bg)\|var(--panel)\|var(--panel2)\|var(--muted)' web/src
```

Replace each with the semantic equivalent (`--surface`, `--surface-raised`, `--surface-inset`, `--text-muted`) in both CSS and inline styles. Then delete the four alias lines from `:root`.

- [ ] **Step 2: Dead-class cross-check**

```bash
# classes defined in CSS
grep -o '^\.[a-z][a-zA-Z0-9_-]*' web/src/styles.css | sort -u > /tmp/css-classes.txt
# classes used in tsx
grep -rhoE 'className="[^"]*"' web/src --include='*.tsx' | tr ' "' '\n' | grep -v '^className=' | sort -u > /tmp/tsx-classes.txt
```

Compare by hand (list is ~150 entries): CSS class unused in tsx → delete the rule (watch for classes composed dynamically, e.g. `` `badge ${…}` ``, `scard ${open ? 'open' : ''}` — grep the base name before deleting). tsx class missing from CSS → add or fix the rule.

- [ ] **Step 3: Inline-style sweep**

```bash
grep -rn 'style={{' web/src --include='*.tsx' | wc -l
```

For each hit: if an equivalent class exists (`.row` gap variants, width overrides, margin one-offs) — replace with a class or a small utility (`.w-160 { width: 160px }` only if used 3+ times); genuinely unique one-offs stay inline. Target: cut the count roughly in half; do not chase zero.

- [ ] **Step 4: Reorganize `styles.css` into labeled sections**

Order: `/* tokens */`, `/* base */`, `/* layout (shell, sidebar) */`, `/* components (btn, card, badge, table, input, modal, copy-row, empty-state, advanced) */`, `/* screens (home, connections, tools, workspaces, agents, activity, landing) */`. Pure move, no value edits in this step.

- [ ] **Step 5: Verify**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS. Browser: click through every screen in both themes looking for broken styling.

- [ ] **Step 6: Commit**

```bash
git add web/src
git commit -m "refactor(web): purge dead CSS, drop legacy aliases, organize stylesheet sections"
```

---

### Task 12: Final verification pass

**Files:** none (verification only; fix regressions found).

- [ ] **Step 1: Full checks**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all PASS (server tests unaffected).

- [ ] **Step 2: Manual E2E, both themes**

`make dev`, fresh account: register → hero → connect a source (mcp or http) → test → import tools → hide one tool → create workspace → assign tools → create agent → key modal → copy endpoint → `curl` tools/list with the key → check Activity shows the call → Home shows all steps done. Repeat visual pass in dark mode.

- [ ] **Step 3: Screenshots**

Capture light + dark screenshots of Home, Connections, Tools, Agents key modal for the PR description.

- [ ] **Step 4: Commit any fixes, then done**

Branch ready for PR: `redesign/web-ui` → `main`.
