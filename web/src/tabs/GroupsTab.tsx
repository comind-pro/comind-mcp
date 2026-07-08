import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { api, type Group, type ImportReport, type Schedule, type Source, type Tool } from '../api.js';
import { Icon } from '../icons.js';
import { CopyRow, EmptyState, Loading, useConfirm } from '../ui.js';
import { ToolPicker } from './ToolPicker.js';

export function GroupsTab() {
  const [groups, setGroups] = useState<Group[] | null>(null);
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
  const [saveState, setSaveState] = useState<'' | 'saving' | 'saved'>('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ groupId: string; toolIds: string[] } | null>(null);
  const { confirm, element: confirmEl } = useConfirm();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [importReport, setImportReport] = useState<ImportReport | null>(null);

  // cleanup fires on openId change (before the next open) and on unmount — flush any
  // debounced save still pending instead of dropping it, so the last toggle isn't lost.
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (savedResetTimer.current) clearTimeout(savedResetTimer.current);
      const p = pending.current;
      if (p) {
        pending.current = null;
        void api.put(`/groups/${p.groupId}/tools`, { toolIds: p.toolIds }).catch(() => {});
      }
    };
  }, [openId]);

  const loadCounts = async (gs: Group[]) => {
    const entries = await Promise.all(
      gs.map(async (g) => [g.id, (await api.get<Tool[]>(`/groups/${g.id}/tools`)).length] as const),
    );
    setCounts(Object.fromEntries(entries));
  };
  const loadGroups = async () => {
    try {
      const gs = await api.get<Group[]>('/groups');
      setGroups(gs);
      void loadCounts(gs);
    } catch (e) {
      setErr(String((e as Error).message));
      setGroups([]);
    }
  };
  useEffect(() => {
    void loadGroups();
    void api.get<Tool[]>('/tools').then(setTools);
    void api.get<Source[]>('/sources').then(setSources);
  }, []);

  if (groups === null) return <Loading />;

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
      const g = await api.post<Group>('/groups', { name: draft });
      setDraft(null);
      await loadGroups();
      // open the new workspace right away
      setOpenId(g.id);
      setAssigned(new Set());
      setSchedules([]);
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const onToolsChange = (next: Set<string>, groupId: string) => {
    setAssigned(next);
    pending.current = { groupId, toolIds: [...next] };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setErr('');
      setSaveState('saving');
      try {
        await api.put(`/groups/${groupId}/tools`, { toolIds: [...next] });
        pending.current = null;
        setCounts((c) => ({ ...c, [groupId]: next.size }));
        setSaveState('saved');
        if (savedResetTimer.current) clearTimeout(savedResetTimer.current);
        savedResetTimer.current = setTimeout(() => setSaveState((s) => (s === 'saved' ? '' : s)), 1500);
      } catch (e) {
        pending.current = null;
        setErr(String((e as Error).message));
        setSaveState('');
      }
    }, 600);
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

  const exportGroup = async (g: Group) => {
    setErr('');
    try {
      const bundle = await api.get<unknown>(`/groups/${g.id}/export`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${g.slug}.bundle.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const importBundle = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    setErr('');
    setImportReport(null);
    try {
      const bundle = JSON.parse(await file.text());
      setImportReport(await api.post<ImportReport>('/groups/import', bundle));
      await loadGroups();
    } catch (err2) {
      setErr(String((err2 as Error).message));
    }
  };

  const delGroup = async (g: Group) => {
    if (
      !(await confirm(
        `Delete workspace "${g.name}"? Its agent grants and schedules will be removed too.`,
        'Delete workspace',
      ))
    )
      return;
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
        {saveState && <span className="save-state">{saveState === 'saving' ? 'Saving…' : 'Saved'}</span>}
      </div>
      <div className="hint">Changes save automatically.</div>
      <ToolPicker tools={tools} sources={sources} selected={assigned} onChange={(next) => onToolsChange(next, g.id)} />

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
        <button className="ghost" onClick={() => exportGroup(g)}>
          Export
        </button>
        <span className="ml-auto" />
        <button className="danger" onClick={() => delGroup(g)}>
          Delete workspace
        </button>
      </div>
      {err && <div className="err-msg">{err}</div>}
    </div>
  );

  return (
    <>
      {confirmEl}
      <div className="intro">
        A workspace bundles chosen tools into one endpoint you hand to an agent. Different agents can get different
        workspaces.
      </div>

      <div className="page-head">
        <div>
          <span className="sub">{groups.length} workspaces</span>
        </div>
        <div className="row">
          <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={importBundle} />
          <button className="ghost" onClick={() => fileInput.current?.click()}>
            Import
          </button>
          <button className="btn-primary" onClick={() => setDraft(draft === null ? '' : null)}>
            + New workspace
          </button>
        </div>
      </div>

      {importReport && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="card-head-row">
            <h2>Import {importReport.group === 'created' ? 'complete' : 'merged'}</h2>
            <button className="ghost" onClick={() => setImportReport(null)}>
              Dismiss
            </button>
          </div>
          <div className="fs-12">
            Sources: {importReport.sources.created.length} created, {importReport.sources.skipped.length} existing ·
            Tools: {importReport.tools.created.length} created, {importReport.tools.skipped.length} existing · Secrets:{' '}
            {importReport.secrets.created.length} created
          </div>
          {importReport.secretsToFill.length > 0 && (
            <div className="fs-12" style={{ marginTop: 6 }}>
              <strong>Fill these secrets on the Secrets page:</strong>{' '}
              <span className="mono">{importReport.secretsToFill.join(', ')}</span>
            </div>
          )}
        </div>
      )}

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
              <span className="edit-link">{open ? <Icon name="x" size={15} /> : 'Configure'}</span>
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
