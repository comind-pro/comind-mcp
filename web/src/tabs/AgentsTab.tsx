import { useEffect, useState } from 'react';
import { type Agent, type AgentKey, api, type Group, SYSTEM_TOOLS } from '../api.js';
import { CopyRow } from '../ui.js';

interface InspectGroup {
  group: { id: string; name: string; slug: string; schedulingEnabled: boolean };
  tools: { name: string; kind: string }[];
  builtinTools: string[];
}

export function AgentsTab() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [draft, setDraft] = useState<string | null>(null); // new-agent name (null = closed)
  const [openId, setOpenId] = useState<string | null>(null);
  const [inspect, setInspect] = useState<Record<string, InspectGroup[]>>({});
  const [addSel, setAddSel] = useState<Record<string, string>>({});
  const [connMode, setConnMode] = useState<'all' | 'single'>('all');
  const [connGroup, setConnGroup] = useState('');
  const [keys, setKeys] = useState<Record<string, AgentKey[]>>({});
  const [freshKeys, setFreshKeys] = useState<Record<string, string>>({}); // keyId → raw token (shown once)
  const [sysTools, setSysTools] = useState<Set<string>>(new Set());
  const [exTool, setExTool] = useState<string | null>(null); // system tool whose example is open
  const [err, setErr] = useState('');

  const loadKeys = async (id: string) => {
    const ks = await api.get<AgentKey[]>(`/agents/${id}/keys`);
    setKeys((m) => ({ ...m, [id]: ks }));
  };

  const openAgent = (a: Agent) => {
    if (openId === a.id) return setOpenId(null);
    setOpenId(a.id);
    setConnMode('all');
    setConnGroup(a.groups?.[0]?.id ?? '');
    setSysTools(new Set(a.systemTools ?? []));
    void loadKeys(a.id);
  };

  const toggleSys = (name: string) => {
    setSysTools((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  const saveSysTools = async (a: Agent) => {
    setErr('');
    try {
      await api.put(`/agents/${a.id}/system-tools`, { names: [...sysTools] });
      setAgents((as) => as.map((x) => (x.id === a.id ? { ...x, systemTools: [...sysTools] } : x)));
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const addKey = async (id: string) => {
    setErr('');
    try {
      const k = await api.post<AgentKey & { apiKey: string }>(`/agents/${id}/keys`, { label: '' });
      setFreshKeys((m) => ({ ...m, [k.id]: k.apiKey }));
      await loadKeys(id);
      await load();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const setArchived = async (id: string, keyId: string, archived: boolean) => {
    await api.patch(`/agents/${id}/keys/${keyId}`, { archived }).catch((e) => setErr(String(e.message)));
    await loadKeys(id);
    await load();
  };

  const delKey = async (id: string, keyId: string) => {
    if (!confirm('Delete this key? It stops working immediately.')) return;
    await api.del(`/agents/${id}/keys/${keyId}`).catch((e) => setErr(String(e.message)));
    setFreshKeys((m) => {
      const n = { ...m };
      delete n[keyId];
      return n;
    });
    await loadKeys(id);
    await load();
  };

  const load = () => api.get<Agent[]>('/agents').then(setAgents);
  useEffect(() => {
    void load();
    void api.get<Group[]>('/groups').then(setGroups);
  }, []);

  const create = async () => {
    setErr('');
    try {
      const a = await api.post<Agent & { apiKey: string }>('/agents', { name: draft });
      setDraft(null);
      await load();
      // open the new agent and reveal its first key once
      setOpenId(a.id);
      setConnMode('all');
      const ks = await api.get<AgentKey[]>(`/agents/${a.id}/keys`);
      setKeys((m) => ({ ...m, [a.id]: ks }));
      if (ks[0]) setFreshKeys((m) => ({ ...m, [ks[0].id]: a.apiKey }));
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const del = async (id: string) => {
    if (!confirm('Delete this agent? Its key stops working immediately.')) return;
    await api.del(`/agents/${id}`);
    if (openId === id) setOpenId(null);
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

  const body = (a: Agent) => {
    const granted = a.groups ?? [];
    const grantedIds = new Set(granted.map((g) => g.id));
    const available = groups.filter((g) => !grantedIds.has(g.id));
    const single = connMode === 'single';
    const g = granted.find((x) => x.id === connGroup);
    const ep = single ? (g ? `${api.base}/g/${g.id}/mcp` : '') : `${api.base}/a/mcp`;
    const addName = single ? (g?.slug ?? 'vmcp') : a.name.replace(/\s+/g, '-');
    return (
      <div className="editor-left" style={{ borderRight: 'none' }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span className="editor-section" style={{ margin: 0 }}>
            Connect
          </span>
          <span className="seg">
            <span className={!single ? 'on' : ''} onClick={() => setConnMode('all')}>
              All V-MCPs
            </span>
            <span className={single ? 'on' : ''} onClick={() => setConnMode('single')}>
              Single V-MCP
            </span>
          </span>
        </div>
        <div className="hint">
          {single
            ? 'Endpoint of one granted V-MCP — exposes only that V-MCP’s tools.'
            : 'One endpoint exposing every tool from all V-MCPs granted to this agent.'}{' '}
          Token = this agent’s key (substitute for <code>&lt;AGENT_KEY&gt;</code>). For ChatGPT / Claude.ai add the
          endpoint as a connector.
        </div>

        {single && (
          <>
            <div className="field-label">V-MCP</div>
            {granted.length ? (
              <select
                className="grow"
                style={{ width: '100%', marginBottom: 10 }}
                value={connGroup}
                onChange={(e) => setConnGroup(e.target.value)}
              >
                {granted.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name} (/{x.slug})
                  </option>
                ))}
              </select>
            ) : (
              <div className="hint" style={{ marginTop: 0 }}>
                No V-MCP granted yet — grant access below.
              </div>
            )}
          </>
        )}

        {ep && (
          <>
            <div className="field-label">MCP endpoint</div>
            <CopyRow text={ep} />
            <div className="field-label" style={{ marginTop: 10 }}>
              Claude Code / Cursor / any MCP client
            </div>
            <CopyRow
              text={`claude mcp add ${addName} --transport http ${ep} --header "Authorization: Bearer <AGENT_KEY>"`}
            />
            <div className="field-label" style={{ marginTop: 10 }}>
              curl (raw JSON-RPC — tools/list)
            </div>
            <CopyRow
              text={`curl -X POST ${ep} \\
  -H "Authorization: Bearer <AGENT_KEY>" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`}
            />
          </>
        )}

        <div className="editor-section" style={{ marginTop: 22 }}>
          V-MCP access
        </div>
        {granted.map((gr) => (
          <div key={gr.id} className="row" style={{ marginBottom: 6, alignItems: 'center' }}>
            <span className="tbadge" style={{ minWidth: 120, textAlign: 'center' }}>
              {gr.name}
            </span>
            <span className="mono muted grow" style={{ fontSize: 12 }}>
              /g/{gr.slug}/mcp
            </span>
            <button className="danger" onClick={() => revoke(a.id, gr.id)}>
              Revoke
            </button>
          </div>
        ))}
        {!granted.length && (
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            No access granted.
          </div>
        )}
        <div className="row" style={{ marginTop: 6 }}>
          <select
            className="grow"
            value={addSel[a.id] ?? ''}
            onChange={(e) => setAddSel((s) => ({ ...s, [a.id]: e.target.value }))}
          >
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
          <div style={{ marginTop: 8, fontSize: 12.5 }}>
            {inspect[a.id].map((ig) => (
              <div key={ig.group.id} style={{ marginBottom: 4 }}>
                <b>{ig.group.name}</b>: {ig.tools.map((t) => t.name).join(', ') || '—'}
                {ig.builtinTools.length > 0 && ` + ${ig.builtinTools.join(', ')}`}
              </div>
            ))}
          </div>
        )}

        <div className="editor-section" style={{ marginTop: 22 }}>
          System tools
        </div>
        <div className="hint">
          Built-in <code className="mono">system.*</code> introspection tools this agent exposes — applied to every
          V-MCP it connects to and the agent-wide <code className="mono">/a/mcp</code>. The agent calls these to learn
          its context instead of guessing. Click <b>example</b> to see what each returns. Don't forget to save.
        </div>
        {SYSTEM_TOOLS.map((s) => {
          const open = exTool === s.name;
          return (
            <div key={s.name}>
              <div className="picker-item" style={{ alignItems: 'center' }}>
                <input type="checkbox" checked={sysTools.has(s.name)} onChange={() => toggleSys(s.name)} />
                <span className="mono">{s.name}</span>
                <span className="muted" style={{ fontSize: 12 }}>
                  {s.label}
                </span>
                <span style={{ marginLeft: 'auto' }} />
                <button className="ghost mini" onClick={() => setExTool(open ? null : s.name)}>
                  {open ? 'hide' : 'example'}
                </button>
              </div>
              {open && (
                <pre
                  className="mono"
                  style={{
                    margin: '2px 0 8px 26px',
                    padding: '8px 10px',
                    fontSize: 11.5,
                    lineHeight: 1.45,
                    background: 'var(--panel2)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    color: 'var(--muted)',
                    overflowX: 'auto',
                    whiteSpace: 'pre',
                  }}
                >
                  {s.example}
                </pre>
              )}
            </div>
          );
        })}
        <div className="spacer" />
        <button className="btn-primary" onClick={() => saveSysTools(a)}>
          Save system tools ({sysTools.size})
        </button>

        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', margin: '22px 0 8px' }}>
          <span className="editor-section" style={{ margin: 0 }}>
            API keys
          </span>
          <button className="btn-primary" onClick={() => addKey(a.id)}>
            + Add key
          </button>
        </div>
        {(keys[a.id] ?? []).map((k) => {
          const fresh = freshKeys[k.id];
          return (
            <div key={k.id} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
              <div className="row" style={{ alignItems: 'center' }}>
                <span className="mono" style={{ fontSize: 13, opacity: k.archived ? 0.5 : 1 }}>
                  {k.prefix}
                  {'…'}
                </span>
                {k.label && <span className="tbadge">{k.label}</span>}
                {k.archived && <span className="badge muted">archived</span>}
                <span className="muted" style={{ fontSize: 12 }}>
                  added {new Date(k.createdAt).toLocaleDateString()}
                </span>
                <span style={{ marginLeft: 'auto' }} />
                <button className="ghost" onClick={() => setArchived(a.id, k.id, !k.archived)}>
                  {k.archived ? 'Unarchive' : 'Archive'}
                </button>
                <button className="danger" onClick={() => delKey(a.id, k.id)}>
                  Delete
                </button>
              </div>
              {fresh && (
                <div className="row" style={{ alignItems: 'stretch', marginTop: 6 }}>
                  <div className="endpoint mono grow" style={{ color: 'var(--ok)' }}>
                    {fresh}
                  </div>
                  <button className="ghost" onClick={() => copy(fresh)}>
                    Copy
                  </button>
                </div>
              )}
              {fresh && (
                <div className="hint" style={{ marginTop: 4 }}>
                  Shown once — copy it now.
                </div>
              )}
            </div>
          );
        })}
        {!(keys[a.id] ?? []).length && (
          <div className="muted" style={{ fontSize: 12 }}>
            No keys.
          </div>
        )}

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }} className="row">
          <button className="danger" style={{ marginLeft: 'auto' }} onClick={() => del(a.id)}>
            Delete agent
          </button>
        </div>
        {err && <div className="err-msg">{err}</div>}
      </div>
    );
  };

  return (
    <>
      <div className="intro">
        <b>Agents</b> — consumers. Each agent = one identity with a key. Grant the agent access to V-MCPs; the key works
        only for granted V-MCPs. Access ≠ auto-connection: you add the V-MCP endpoint to your external agent yourself.
      </div>

      <div className="page-head">
        <div>
          <span className="sub">{agents.length} agents</span>
        </div>
        <button className="btn-primary" onClick={() => setDraft(draft === null ? '' : null)}>
          + New agent
        </button>
      </div>

      {draft !== null && (
        <div className="scard open">
          <div className="scard-body">
            <div className="editor-left" style={{ borderRight: 'none' }}>
              <div className="field-label">Name</div>
              <div className="row">
                <input
                  className="grow"
                  placeholder="e.g. chatgpt-reporter"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <button className="btn-primary" onClick={create} disabled={!draft}>
                  Create
                </button>
                <button className="ghost" onClick={() => setDraft(null)}>
                  Cancel
                </button>
              </div>
              <div className="hint">Just a name. Grant V-MCP access after creating.</div>
              {err && <div className="err-msg">{err}</div>}
            </div>
          </div>
        </div>
      )}

      {agents.map((a) => {
        const open = openId === a.id;
        const granted = a.groups ?? [];
        return (
          <div key={a.id} className={`scard ${open ? 'open' : ''}`}>
            <div className="scard-head" onClick={() => openAgent(a)}>
              <span className="name src-name">{a.name}</span>
              <span className="muted" style={{ fontSize: 12, width: 70 }}>
                {a.keyCount ?? 0} key{(a.keyCount ?? 0) === 1 ? '' : 's'}
              </span>
              <span className="muted" style={{ fontSize: 12 }}>
                {granted.length ? `${granted.length} V-MCP` : 'no access'}
              </span>
              <span style={{ marginLeft: 'auto' }} />
              <span className="edit-link">{open ? 'Close' : 'Manage'}</span>
              <span className={`chev ${open ? 'up' : ''}`}>⌄</span>
            </div>
            {open && <div className="scard-body">{body(a)}</div>}
          </div>
        );
      })}

      {!agents.length && draft === null && (
        <div className="muted" style={{ padding: '20px 2px' }}>
          No agents yet.
        </div>
      )}
    </>
  );
}
