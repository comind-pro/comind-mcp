import { useEffect, useState } from 'react';
import { api, type Group, type Schedule, type Source, type Tool } from '../api.js';
import { ToolPicker } from './ToolPicker.js';

export function GroupsTab() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [assigned, setAssigned] = useState<Set<string>>(new Set());
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [draft, setDraft] = useState<string | null>(null); // new-group name (null = closed)
  const [cron, setCron] = useState('0 9 * * *');
  const [schTool, setSchTool] = useState('');
  const [err, setErr] = useState('');
  const [counts, setCounts] = useState<Record<string, number>>({});

  const loadCounts = async (gs: Group[]) => {
    const entries = await Promise.all(
      gs.map(async (g) => [g.id, (await api.get<Tool[]>(`/groups/${g.id}/tools`)).length] as const),
    );
    setCounts(Object.fromEntries(entries));
  };
  const loadGroups = async () => {
    const gs = await api.get<Group[]>('/groups');
    setGroups(gs);
    void loadCounts(gs);
  };
  useEffect(() => {
    void loadGroups();
    void api.get<Tool[]>('/tools').then(setTools);
    void api.get<Source[]>('/sources').then(setSources);
  }, []);

  const select = async (g: Group) => {
    if (openId === g.id) return setOpenId(null);
    setOpenId(g.id);
    setErr('');
    const gt = await api.get<Tool[]>(`/groups/${g.id}/tools`);
    setAssigned(new Set(gt.map((t) => t.id)));
    setSchedules(await api.get<Schedule[]>(`/groups/${g.id}/schedules`));
  };

  const create = async () => {
    setErr('');
    try {
      await api.post('/groups', { name: draft });
      setDraft(null);
      await loadGroups();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const saveToolset = async (g: Group) => {
    setErr('');
    try {
      await api.put(`/groups/${g.id}/tools`, { toolIds: [...assigned] });
      setCounts((c) => ({ ...c, [g.id]: assigned.size }));
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const addSchedule = async (g: Group) => {
    setErr('');
    try {
      await api.post(`/groups/${g.id}/schedules`, { cron, toolName: schTool });
      setSchedules(await api.get<Schedule[]>(`/groups/${g.id}/schedules`));
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const runNow = async (g: Group, sid: string) => {
    await api.post(`/schedules/${sid}/run`).catch((e) => setErr(String(e.message)));
    setSchedules(await api.get<Schedule[]>(`/groups/${g.id}/schedules`));
  };

  const delSchedule = async (g: Group, sid: string) => {
    await api.del(`/schedules/${sid}`);
    setSchedules(await api.get<Schedule[]>(`/groups/${g.id}/schedules`));
  };

  const delGroup = async (g: Group) => {
    if (!confirm(`Delete V-MCP "${g.name}"? Its agents grants and schedules will be removed too.`)) return;
    setErr('');
    try {
      await api.del(`/groups/${g.id}`);
      if (openId === g.id) setOpenId(null);
      await loadGroups();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const assignedNames = tools.filter((t) => assigned.has(t.id)).map((t) => t.name);

  const body = (g: Group) => (
    <div className="editor-left" style={{ borderRight: 'none' }}>
      <div className="hint">
        Endpoint <code className="mono">/g/{g.slug}/mcp</code> — connect it from the <b>Agents</b> tab (pick an agent →
        Connect → Single V-MCP).
      </div>

      <div className="editor-section" style={{ marginTop: 14 }}>
        Toolset
      </div>
      <div className="hint">Tools this V-MCP exposes to agents. Don't forget to save.</div>
      <ToolPicker tools={tools} sources={sources} selected={assigned} onChange={setAssigned} />
      <div className="spacer" />
      <button className="btn-primary" onClick={() => saveToolset(g)}>
        Save toolset ({assigned.size})
      </button>

      <div className="editor-section" style={{ marginTop: 22 }}>
        Schedules
      </div>
      <div className="hint">
        Cron schedules that auto-run a group tool. Run now — execute immediately. Agents can also self-schedule via
        schedule_task / list_schedules / cancel_schedule.
      </div>
      <div className="row">
        <input
          className="mono"
          style={{ width: 160 }}
          placeholder="0 9 * * *"
          value={cron}
          onChange={(e) => setCron(e.target.value)}
        />
        <select className="grow" value={schTool} onChange={(e) => setSchTool(e.target.value)}>
          <option value="">— tool —</option>
          {assignedNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button onClick={() => addSchedule(g)} disabled={!schTool}>
          Add
        </button>
      </div>
      <div className="spacer" />
      {schedules.map((s) => (
        <div
          key={s.id}
          className="row"
          style={{ marginBottom: 6, alignItems: 'center', borderBottom: '1px solid var(--border)', paddingBottom: 6 }}
        >
          <span className="mono" style={{ width: 120 }}>
            {s.cron}
          </span>
          <span className="mono grow">{s.toolName}</span>
          <span className="tbadge">{s.createdBy}</span>
          <span className="muted" style={{ fontSize: 12, width: 150, textAlign: 'right' }}>
            {s.lastRun ? new Date(s.lastRun).toLocaleString() : '—'}
          </span>
          <button className="ghost mini" onClick={() => runNow(g, s.id)}>
            Run now
          </button>
          <button className="danger mini" onClick={() => delSchedule(g, s.id)}>
            Delete
          </button>
        </div>
      ))}
      {!schedules.length && (
        <div className="muted" style={{ fontSize: 12 }}>
          No schedules.
        </div>
      )}

      <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }} className="row">
        <button className="danger" onClick={() => delGroup(g)}>
          Delete V-MCP
        </button>
      </div>
      {err && <div className="err-msg">{err}</div>}
    </div>
  );

  return (
    <>
      <div className="intro">
        <b>V-MCP (virtual MCP)</b> — assemble tools from different sources into one virtual MCP server with a single
        endpoint <code>/g/&lt;slug&gt;/mcp</code>. Give different V-MCPs to different agents → each sees only its set.
        Built-in self-cron tools let a connected agent schedule itself.
      </div>

      <div className="page-head">
        <div>
          <span className="title">V-MCP</span>
          <span className="sub">{groups.length} servers</span>
        </div>
        <button className="btn-primary" onClick={() => setDraft(draft === null ? '' : null)}>
          + New V-MCP
        </button>
      </div>

      {err && !openId && draft === null && <div className="err-msg">{err}</div>}

      {draft !== null && (
        <div className="scard open">
          <div className="scard-body">
            <div className="editor-left" style={{ borderRight: 'none' }}>
              <div className="field-label">Name · slug auto-generated</div>
              <div className="row">
                <input
                  className="grow"
                  placeholder="e.g. ops-reporting"
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
              {err && <div className="err-msg">{err}</div>}
            </div>
          </div>
        </div>
      )}

      {groups.map((g) => {
        const open = openId === g.id;
        return (
          <div key={g.id} className={`scard ${open ? 'open' : ''}`}>
            <div className="scard-head" onClick={() => select(g)}>
              <span className="name src-name">{g.name}</span>
              <span className="mono muted" style={{ fontSize: 12, width: 120 }}>
                /{g.slug}
              </span>
              <span className="muted" style={{ fontSize: 12.5 }}>
                {counts[g.id] ?? '…'} tools
              </span>
              <span style={{ marginLeft: 'auto' }} />
              <span className="edit-link">{open ? 'Close' : 'Configure'}</span>
              <span className={`chev ${open ? 'up' : ''}`}>⌄</span>
            </div>
            {open && <div className="scard-body">{body(g)}</div>}
          </div>
        );
      })}

      {!groups.length && draft === null && (
        <div className="muted" style={{ padding: '20px 2px' }}>
          No V-MCP servers yet.
        </div>
      )}
    </>
  );
}
