import { useEffect, useState } from 'react';
import { api, tokenStore, type AuthUser } from './api.js';
import { AuthPage } from './AuthPage.js';
import { AgentsTab } from './tabs/AgentsTab.js';
import { GroupsTab } from './tabs/GroupsTab.js';
import { LogsTab } from './tabs/LogsTab.js';
import { SecretsTab } from './tabs/SecretsTab.js';
import { SourcesTab } from './tabs/SourcesTab.js';
import { ToolsTab } from './tabs/ToolsTab.js';

const TABS = ['Sources', 'Tools', 'V-MCP', 'Agents', 'Secrets', 'Logs'] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const [tab, setTab] = useState<Tab>('Sources');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    const drop = () => setUser(null);
    window.addEventListener('comind-unauthorized', drop);
    if (tokenStore.get()) {
      api.me().then(setUser).catch(() => setUser(null)).finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
    return () => window.removeEventListener('comind-unauthorized', drop);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);

  const logout = () => {
    api.logout();
    setUser(null);
  };

  if (loading) return <div style={{ padding: 40 }} className="muted">Loading…</div>;
  if (!user) return <AuthPage onAuth={setUser} />;

  return (
    <>
      <div className="topbar">
        <div className="brand">
          comind-mcp<small>MCP gateway · {api.base}</small>
        </div>
        <div className="tabs">
          {TABS.map((t) => (
            <div key={t} className={`tab ${t === tab ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t}
            </div>
          ))}
          <span className="topbar-sep" />
          <div className="user-menu" onClick={(e) => e.stopPropagation()}>
            <div className="tab" title={user.email} onClick={() => setMenu((m) => !m)}>
              {user.email.split('@')[0]} <span className="muted">▾</span>
            </div>
            {menu && (
              <div className="menu-pop">
                <div className="menu-email">{user.email}</div>
                <div className="menu-item" onClick={logout}>Log out</div>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="flow">
        <span className="step">
          1. <b>Sources</b> — connect API/MCP
        </span>
        <span className="arrow">→</span>
        <span className="step">
          2. <b>Tools</b> — curate / combine
        </span>
        <span className="arrow">→</span>
        <span className="step">
          3. <b>V-MCP</b> — build a virtual MCP
        </span>
        <span className="arrow">→</span>
        <span className="step">
          4. <b>Agents</b> — key + access to V-MCP
        </span>
        <span className="arrow">→</span>
        <span className="step">
          5. <b>Logs</b> — observe
        </span>
      </div>
      <div className="wrap">
        {tab === 'Sources' && <SourcesTab />}
        {tab === 'Tools' && <ToolsTab />}
        {tab === 'V-MCP' && <GroupsTab />}
        {tab === 'Agents' && <AgentsTab />}
        {tab === 'Secrets' && <SecretsTab />}
        {tab === 'Logs' && <LogsTab />}
      </div>
    </>
  );
}
