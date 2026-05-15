import { useEffect, useState } from 'react';
import { api, type Group, type Schedule, type Source, type Tool } from '../api.js';
import { ToolPicker } from './ToolPicker.js';

function Snip({ text }: { text: string }) {
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
    <div className="row" style={{ alignItems: 'stretch', gap: 6, marginBottom: 8 }}>
      <div className="endpoint mono grow" style={{ whiteSpace: 'pre-wrap' }}>
        {text}
      </div>
      <button className="ghost" onClick={copy} style={{ alignSelf: 'flex-start' }}>
        {copied ? '✓' : 'Copy'}
      </button>
    </div>
  );
}

export function GroupsTab() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [sel, setSel] = useState<Group | null>(null);
  const [assigned, setAssigned] = useState<Set<string>>(new Set());
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [name, setName] = useState('');
  const [cron, setCron] = useState('0 9 * * *');
  const [schTool, setSchTool] = useState('');
  const [err, setErr] = useState('');

  const loadGroups = () => api.get<Group[]>('/groups').then(setGroups);
  useEffect(() => {
    void loadGroups();
    void api.get<Tool[]>('/tools').then(setTools);
    void api.get<Source[]>('/sources').then(setSources);
  }, []);

  const select = async (g: Group) => {
    setSel(g);
    setErr('');
    const gt = await api.get<Tool[]>(`/groups/${g.id}/tools`);
    setAssigned(new Set(gt.map((t) => t.id)));
    setSchedules(await api.get<Schedule[]>(`/groups/${g.id}/schedules`));
  };

  const create = async () => {
    setErr('');
    try {
      await api.post('/groups', { name });
      setName('');
      await loadGroups();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const saveToolset = async () => {
    if (!sel) return;
    setErr('');
    try {
      await api.put(`/groups/${sel.id}/tools`, { toolIds: [...assigned] });
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const addSchedule = async () => {
    if (!sel) return;
    setErr('');
    try {
      await api.post(`/groups/${sel.id}/schedules`, { cron, toolName: schTool });
      setSchedules(await api.get<Schedule[]>(`/groups/${sel.id}/schedules`));
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const runNow = async (sid: string) => {
    await api.post(`/schedules/${sid}/run`).catch((e) => setErr(String(e.message)));
    if (sel) setSchedules(await api.get<Schedule[]>(`/groups/${sel.id}/schedules`));
  };

  const delSchedule = async (sid: string) => {
    await api.del(`/schedules/${sid}`);
    if (sel) setSchedules(await api.get<Schedule[]>(`/groups/${sel.id}/schedules`));
  };

  const delGroup = async (g: Group) => {
    if (!confirm(`Delete group "${g.name}"? Agents and schedules of this group will be removed too.`)) return;
    setErr('');
    try {
      await api.del(`/groups/${g.id}`);
      if (sel?.id === g.id) setSel(null);
      await loadGroups();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const assignedNames = tools.filter((t) => assigned.has(t.id)).map((t) => t.name);

  return (
    <>
      <div className="intro">
        <b>V-MCP (virtual MCP)</b> — the heart of the system. V-MCP = <b>virtual MCP server</b>: you assemble a set of tools
        from different sources into it, and it gets a single endpoint <code>/g/&lt;slug&gt;/mcp</code>.
        <br />
        Give different groups to different agents → each one sees only its narrow set. A group also has built-in{' '}
        <b>self-cron tools</b> (schedule_task / list_schedules / cancel_schedule) — a connected agent can schedule
        itself.
      </div>
      <div className="card">
        <h2>New V-MCP</h2>
        <div className="hint">Name the group (the URL slug is generated automatically).</div>
        <div className="row">
          <input className="grow" placeholder="group name" value={name} onChange={(e) => setName(e.target.value)} />
          <button onClick={create} disabled={!name}>
            Create group
          </button>
        </div>
        {err && <div className="err-msg">{err}</div>}
      </div>

      <div className="card">
        <h2>V-MCP servers</h2>
        <div className="hint">Click a V-MCP to configure its toolset and schedules below.</div>
        <div className="row">
          {groups.map((g) => (
            <span key={g.id} className="group-chip">
              <button className={sel?.id === g.id ? '' : 'ghost'} onClick={() => select(g)}>
                {g.name} <span className="muted">/{g.slug}</span>
              </button>
              <button className="chip-x" title="Delete group" onClick={() => delGroup(g)}>
                ×
              </button>
            </span>
          ))}
          {!groups.length && <span className="muted">No groups yet.</span>}
        </div>
      </div>

      {sel && (
        <>
          <div className="card">
            <h2>Connect — {sel.name}</h2>
            <div className="hint">
              This group = one virtual MCP server with a single endpoint. Connect any MCP client. The token is the{' '}
              <b>agent key</b> for this group (create it in the Agents tab; substitute it for <code>&lt;AGENT_KEY&gt;</code>).
            </div>

            <h3>MCP endpoint</h3>
            <Snip text={`${api.base}/g/${sel.id}/mcp`} />

            <h3>Claude Code / Cursor / any MCP client</h3>
            <Snip
              text={`claude mcp add ${sel.slug} --transport http ${api.base}/g/${sel.id}/mcp --header "Authorization: Bearer <AGENT_KEY>"`}
            />

            <h3>curl (raw JSON-RPC — tools/list example)</h3>
            <Snip
              text={`curl -X POST ${api.base}/g/${sel.id}/mcp \\
  -H "Authorization: Bearer <AGENT_KEY>" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`}
            />
            <div className="hint">
              The MCP client (Claude Code) performs the initialize handshake itself. curl is shown to illustrate the format.
            </div>
          </div>

          <div className="card">
            <h2>Toolset — {sel.name}</h2>
            <div className="hint">
              Check the tools this group will expose to agents. This is the content of the virtual MCP. Don't forget to <b>Save</b>.
            </div>
            <h3>Pick tools exposed by this virtual MCP</h3>
            <ToolPicker tools={tools} sources={sources} selected={assigned} onChange={setAssigned} />
            <div className="spacer" />
            <button onClick={saveToolset}>Save toolset ({assigned.size})</button>
          </div>

          <div className="card">
            <h2>Schedules — {sel.name}</h2>
            <div className="hint">
              Cron schedules that automatically run a group tool (e.g. collect a report every morning). <b>Run now</b> —
              run immediately to check. The results of each run are written to the log.
            </div>
            <div className="row">
              <input placeholder="cron (e.g. 0 9 * * *)" value={cron} onChange={(e) => setCron(e.target.value)} />
              <select value={schTool} onChange={(e) => setSchTool(e.target.value)}>
                <option value="">— tool —</option>
                {assignedNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <button onClick={addSchedule} disabled={!schTool}>
                Add schedule
              </button>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              Agents can also self-schedule via the MCP tools schedule_task / list_schedules / cancel_schedule.
            </div>
            <div className="spacer" />
            <table>
              <thead>
                <tr>
                  <th>cron</th>
                  <th>tool</th>
                  <th>by</th>
                  <th>last run</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.cron}</td>
                    <td className="mono">{s.toolName}</td>
                    <td><span className="pill">{s.createdBy}</span></td>
                    <td className="muted">{s.lastRun ? new Date(s.lastRun).toLocaleString() : '—'}</td>
                    <td className="row">
                      <button className="ghost" onClick={() => runNow(s.id)}>
                        Run now
                      </button>
                      <button className="danger" onClick={() => delSchedule(s.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
                {!schedules.length && (
                  <tr>
                    <td colSpan={5} className="muted">
                      No schedules.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
