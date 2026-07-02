import { useEffect, useState } from 'react';
import { AuthPage } from './AuthPage.js';
import { type AuthUser, api, tokenStore } from './api.js';
import { Home } from './Home.js';
import { Icon, type IconName } from './icons.js';
import { AgentsTab } from './tabs/AgentsTab.js';
import { GroupsTab } from './tabs/GroupsTab.js';
import { LogsTab } from './tabs/LogsTab.js';
import { SecretsTab } from './tabs/SecretsTab.js';
import { SourcesTab } from './tabs/SourcesTab.js';
import { ToolsTab } from './tabs/ToolsTab.js';
import { getTheme, toggleTheme } from './theme.js';

export type PageId = 'home' | 'connections' | 'tools' | 'workspaces' | 'agents' | 'secrets' | 'activity';

const PAGES: { id: PageId; label: string; hint: string | null; icon: IconName }[] = [
  { id: 'home', label: 'Home', hint: null, icon: 'home' },
  { id: 'connections', label: 'Connections', hint: 'sources', icon: 'plug' },
  { id: 'tools', label: 'Tools', hint: null, icon: 'wrench' },
  { id: 'workspaces', label: 'Workspaces', hint: 'virtual MCP servers', icon: 'grid' },
  { id: 'agents', label: 'Agents', hint: null, icon: 'bot' },
  { id: 'secrets', label: 'Secrets', hint: null, icon: 'lock' },
  { id: 'activity', label: 'Activity', hint: 'call logs', icon: 'pulse' },
];

export function App() {
  const [page, setPage] = useState<PageId>('home');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState(getTheme());
  const [navOpen, setNavOpen] = useState(false);
  const [rail, setRail] = useState(() => localStorage.getItem('comind_nav') === 'rail');

  const toggleRail = () =>
    setRail((r) => {
      localStorage.setItem('comind_nav', r ? 'full' : 'rail');
      return !r;
    });

  useEffect(() => {
    const drop = () => {
      setUser(null);
      setPage('home');
    };
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
    setPage('home');
  };

  if (loading) return <div className="page-loading text-muted">Loading…</div>;
  if (!user) return <AuthPage onAuth={setUser} />;

  const current = PAGES.find((p) => p.id === page) ?? PAGES[0];

  return (
    <div className="shell">
      <button className="nav-burger" onClick={() => setNavOpen(!navOpen)} aria-label="Menu">
        ☰
      </button>
      <aside className={`sidebar ${navOpen ? 'open' : ''} ${rail ? 'rail' : ''}`}>
        <div className="side-top">
          <div className="side-brand">comind-mcp</div>
          <button
            className="side-rail-toggle"
            onClick={toggleRail}
            title={rail ? 'Expand navigation' : 'Collapse navigation'}
            aria-label={rail ? 'Expand navigation' : 'Collapse navigation'}
          >
            <Icon name="panel" size={16} />
          </button>
        </div>
        <nav>
          {PAGES.map((p) => (
            <button
              key={p.id}
              className={`side-item ${p.id === page ? 'active' : ''}`}
              aria-current={p.id === page ? 'page' : undefined}
              onClick={() => {
                setPage(p.id);
                setNavOpen(false);
              }}
            >
              <span className="side-icon">
                <Icon name={p.icon} />
              </span>
              <span className="side-label">{p.label}</span>
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <button className="side-item" onClick={() => setTheme(toggleTheme())}>
            <span className="side-icon">
              <Icon name={theme === 'light' ? 'moon' : 'sun'} />
            </span>
            <span className="side-label">{theme === 'light' ? 'Dark mode' : 'Light mode'}</span>
          </button>
          <div className="side-user" title={user.email}>
            <span className="side-user-email">{user.email}</span>
            <button className="side-logout" onClick={logout} title="Log out" aria-label="Log out">
              <Icon name="logout" size={16} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="page-head-shell">
          <h1 className="page-title">{current.label}</h1>
          {current.hint && <span className="page-hint">{current.hint}</span>}
        </header>
        {page === 'home' && <Home onNavigate={setPage} />}
        {page === 'connections' && <SourcesTab />}
        {page === 'tools' && <ToolsTab onNavigate={setPage} />}
        {page === 'workspaces' && <GroupsTab />}
        {page === 'agents' && <AgentsTab />}
        {page === 'secrets' && <SecretsTab />}
        {page === 'activity' && <LogsTab />}
      </main>
    </div>
  );
}
