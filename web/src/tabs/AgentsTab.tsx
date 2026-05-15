import { useEffect, useState, type ReactNode } from 'react';
import { api, type Agent, type Group } from '../api.js';

interface InspectGroup {
  group: { id: string; name: string; slug: string; schedulingEnabled: boolean };
  tools: { name: string; kind: string }[];
  builtinTools: string[];
}

export function AgentsTab() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [name, setName] = useState('');
  const [freshKey, setFreshKey] = useState<{ name: string; key: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [inspect, setInspect] = useState<Record<string, InspectGroup[]>>({});
  const [addSel, setAddSel] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');

  const load = () => api.get<Agent[]>('/agents').then(setAgents);
  useEffect(() => {
    void load();
    void api.get<Group[]>('/groups').then(setGroups);
  }, []);

  const create = async () => {
    setErr('');
    try {
      const a = await api.post<Agent & { apiKey: string }>('/agents', { name });
      setFreshKey({ name: a.name, key: a.apiKey });
      setName('');
      await load();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const rotate = async (id: string, nm: string) => {
    const r = await api.post<{ apiKey: string }>(`/agents/${id}/rotate-key`);
    setFreshKey({ name: nm, key: r.apiKey });
  };

  const del = async (id: string) => {
    await api.del(`/agents/${id}`);
    await load();
  };

  const grant = async (id: string) => {
    const groupId = addSel[id];
    if (!groupId) return;
    setErr('');
    try {
      await api.post(`/agents/${id}/groups`, { groupId });
      setAddSel((s) => ({ ...s, [id]: '' }));
      await load();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const revoke = async (id: string, groupId: string) => {
    await api.del(`/agents/${id}/groups/${groupId}`);
    await load();
  };

  const doInspect = async (id: string) => {
    const r = await api.get<{ groups: InspectGroup[] }>(`/agents/${id}/inspect`);
    setInspect((p) => ({ ...p, [id]: r.groups }));
  };

  const copy = (t: string) => navigator.clipboard?.writeText(t).catch(() => {});

  return (
    <>
      <div className="intro">
        <b>Agents</b> — consumers. Each agent = one <b>identity with a key</b>. You{' '}
        <b>grant the agent access to V-MCP</b> (groups) — adding/removing them separately. The key works only for granted V-MCP.
        <br />
        <span className="muted">
          Access ≠ auto-connection: you add the V-MCP endpoint to your external agent (Claude/ChatGPT) yourself. If
          access exists but you haven't added it — the agent won't see it.
        </span>
      </div>

      <div className="card">
        <h2>New agent</h2>
        <div className="hint">Just a name. Grant V-MCP access below.</div>
        <div className="row">
          <input className="grow" placeholder="agent name (e.g. chatgpt-reporter)" value={name} onChange={(e) => setName(e.target.value)} />
          <button onClick={create} disabled={!name}>
            Create agent
          </button>
        </div>
        {err && <div className="err-msg">{err}</div>}
        {freshKey && (
          <div style={{ marginTop: 12 }}>
            <h3>API key for "{freshKey.name}" (shown once — copy it)</h3>
            <div className="row" style={{ alignItems: 'stretch' }}>
              <div className="endpoint mono grow">{freshKey.key}</div>
              <button className="ghost" onClick={() => copy(freshKey.key)}>
                Copy
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Agents</h2>
        <table>
          <thead>
            <tr>
              <th>name</th>
              <th>key</th>
              <th>V-MCP access</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => {
              const granted = a.groups ?? [];
              const grantedIds = new Set(granted.map((g) => g.id));
              const available = groups.filter((g) => !grantedIds.has(g.id));
              return (
                <FragRow key={a.id}>
                  <tr style={{ cursor: 'pointer' }}>
                    <td onClick={() => setExpanded(expanded === a.id ? null : a.id)}>
                      <span className="muted">{expanded === a.id ? '▾' : '▸'}</span> {a.name}
                    </td>
                    <td className="mono muted">{a.apiKeyPrefix}…</td>
                    <td>
                      {granted.length ? (
                        granted.map((g) => (
                          <span key={g.id} className="pill" style={{ marginRight: 4 }}>
                            {g.name}
                          </span>
                        ))
                      ) : (
                        <span className="muted">no access</span>
                      )}
                    </td>
                    <td className="row">
                      <button className="ghost" onClick={() => rotate(a.id, a.name)}>
                        Rotate key
                      </button>
                      <button className="danger" onClick={() => del(a.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                  {expanded === a.id && (
                    <tr>
                      <td colSpan={4}>
                        <h3>V-MCP access</h3>
                        {granted.map((g) => (
                          <div key={g.id} className="row" style={{ marginBottom: 6, alignItems: 'stretch' }}>
                            <span className="pill" style={{ minWidth: 120 }}>
                              {g.name}
                            </span>
                            <div className="endpoint mono grow">{g.endpoint}</div>
                            <button className="ghost" onClick={() => copy(g.endpoint)}>
                              Copy
                            </button>
                            <button className="danger" onClick={() => revoke(a.id, g.id)}>
                              Revoke
                            </button>
                          </div>
                        ))}
                        <div className="row" style={{ marginTop: 6 }}>
                          <select value={addSel[a.id] ?? ''} onChange={(e) => setAddSel((s) => ({ ...s, [a.id]: e.target.value }))}>
                            <option value="">— grant V-MCP access —</option>
                            {available.map((g) => (
                              <option key={g.id} value={g.id}>
                                {g.name}
                              </option>
                            ))}
                          </select>
                          <button onClick={() => grant(a.id)} disabled={!addSel[a.id]}>
                            Grant
                          </button>
                          <button className="ghost" onClick={() => doInspect(a.id)}>
                            Inspect
                          </button>
                        </div>
                        {inspect[a.id] && (
                          <div className="kv" style={{ marginTop: 8, display: 'block' }}>
                            {inspect[a.id].map((ig) => (
                              <div key={ig.group.id} style={{ marginBottom: 4 }}>
                                <b>{ig.group.name}</b>: {ig.tools.map((t) => t.name).join(', ') || '—'}
                                {ig.builtinTools.length > 0 && ` + ${ig.builtinTools.join(', ')}`}
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </FragRow>
              );
            })}
            {!agents.length && (
              <tr>
                <td colSpan={4} className="muted">
                  No agents yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function FragRow({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
