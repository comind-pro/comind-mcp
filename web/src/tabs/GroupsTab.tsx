import { useEffect, useState } from 'react';
import { api, type Group, type Schedule, type Source, type Tool } from '../api.js';
import { CopyRow, EmptyState } from '../ui.js';
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
    if (!confirm(`Delete workspace "${g.name}"? Its agent grants and schedules will be removed too.`)) return;
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
    <div className="editor-left no-border-r">
      <CopyRow label="MCP endpoint" text={`${api.base}/g/${g.slug}/mcp`} />
      <div className="hint">Connect it from the Agents page — the agent's key authorizes this endpoint.</div>

      <div className="editor-section" style={{ marginTop: 14 }}>
        Tools in this workspace
      </div>
      <div className="hint">Tools assigned to this workspace. Don't forget to save.</div>
      <ToolPicker tools={tools} sources={sources} selected={assigned} onChange={setAssigned} />
      <div className="spacer" />
      <button className="btn-primary" onClick={() => saveToolset(g)}>
        Save tools ({assigned.size})
      </button>

      <div className="editor-section" style={{ marginTop: 22 }}>
        Schedules
      </div>
      <div className="hint">
        Run a tool automatically on a cron schedule. Connected agents can also schedule themselves.
      </div>
      <div className="row">
        <input className="mono w-160" placeholder="0 9 * * *" value={cron} onChange={(e) => setCron(e.target.value)} />
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
          <span className="mono w-120">{s.cron}</span>
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
      {!schedules.length && <div className="muted fs-12">No schedules.</div>}

      <div className="row divider-top">
        <button className="danger" onClick={() => delGroup(g)}>
          Delete workspace
        </button>
      </div>
      {err && <div className="err-msg">{err}</div>}
    </div>
  );

  return (
    <>
      <div className="intro">
        A workspace bundles chosen tools into one endpoint you hand to an agent. Different agents can get different
        workspaces.
      </div>

      <div className="page-head">
        <div>
          <span className="sub">{groups.length} workspaces</span>
        </div>
        <button className="btn-primary" onClick={() => setDraft(draft === null ? '' : null)}>
          + New workspace
        </button>
      </div>

      {err && !openId && draft === null && <div className="err-msg">{err}</div>}

      {draft !== null && (
        <div className="scard open">
          <div className="scard-body">
            <div className="editor-left no-border-r">
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
              <span className="ml-auto" />
              <span className="edit-link">{open ? 'Close' : 'Configure'}</span>
              <span className={`chev ${open ? 'up' : ''}`}>⌄</span>
            </div>
            {open && <div className="scard-body">{body(g)}</div>}
          </div>
        );
      })}

      {!groups.length && draft === null && (
        <EmptyState
          title="No workspaces yet"
          body="A workspace turns your curated tools into a single endpoint for an agent."
          actionLabel="+ New workspace"
          onAction={() => setDraft('')}
        />
      )}
    </>
  );
}
