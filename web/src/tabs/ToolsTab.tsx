import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type Source, type Tool } from '../api.js';
import { CompositeBuilder } from './CompositeBuilder.js';

interface StepTrace {
  id: string;
  tool: string;
  text: string;
  isError: boolean;
  skipped?: boolean;
}
interface RunResult {
  content: { text?: string }[];
  isError?: boolean;
  steps?: StepTrace[];
}

function Frag({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function ToolsTab() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [err, setErr] = useState('');

  const [search, setSearch] = useState('');
  const [fSource, setFSource] = useState('');
  const [fKind, setFKind] = useState('');

  const [expanded, setExpanded] = useState<string | null>(null);
  const [editDef, setEditDef] = useState('');
  const [testArgs, setTestArgs] = useState('{}');
  const [testOut, setTestOut] = useState<RunResult | null>(null);
  const [openSec, setOpenSec] = useState<Set<string>>(new Set());

  const load = () => api.get<Tool[]>('/tools').then(setTools).catch((e) => setErr(String(e.message)));
  useEffect(() => {
    void load();
    void api.get<Source[]>('/sources').then(setSources);
  }, []);

  const srcName = (id: string | null) => sources.find((s) => s.id === id)?.name ?? '—';

  const patch = async (id: string, body: Record<string, unknown>) => {
    setErr('');
    try {
      await api.patch(`/tools/${id}`, body);
      await load();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const rename = async (t: Tool) => {
    const name = prompt('New unique name', t.name);
    if (name && name !== t.name) await patch(t.id, { name });
  };

  const del = async (id: string) => {
    await api.del(`/tools/${id}`).catch((e) => setErr(String(e.message)));
    if (expanded === id) setExpanded(null);
    await load();
  };

  const toggle = async (t: Tool) => {
    if (expanded === t.id) return setExpanded(null);
    setExpanded(t.id);
    setTestOut(null);
    setTestArgs('{}');
    setErr('');
    if (t.kind === 'composite') {
      const full = await api.get<Tool & { definition: unknown }>(`/composite-tools/${t.id}`);
      setEditDef(JSON.stringify(full.definition, null, 2));
    } else {
      setEditDef('');
    }
  };

  const saveDef = async (id: string) => {
    setErr('');
    try {
      await api.patch(`/composite-tools/${id}`, { definition: JSON.parse(editDef) });
      await load();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const test = async (t: Tool) => {
    setTestOut(null);
    setErr('');
    try {
      const args = JSON.parse(testArgs || '{}');
      const r = await api.post<RunResult>(`/tools/${t.id}/test`, { args });
      setTestOut(r);
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const filtered = tools.filter(
    (t) =>
      (!search || t.name.toLowerCase().includes(search.toLowerCase())) &&
      (!fSource || t.sourceId === fSource) &&
      (!fKind || t.kind === fKind),
  );

  // Group filtered tools into collapsible sections by source (composites separate).
  const sections = useMemo(() => {
    const m = new Map<string, { key: string; label: string; tools: Tool[] }>();
    for (const t of filtered) {
      const key = t.kind === 'composite' ? '__composite' : t.sourceId ?? '__none';
      const label = t.kind === 'composite' ? 'Composite tools' : srcName(t.sourceId);
      if (!m.has(key)) m.set(key, { key, label, tools: [] });
      m.get(key)!.tools.push(t);
    }
    return [...m.values()].sort((a, b) => a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sources]);

  const toggleSec = (key: string) => {
    const next = new Set(openSec);
    next.has(key) ? next.delete(key) : next.add(key);
    setOpenSec(next);
  };

  const renderRow = (t: Tool) => (
    <Frag key={t.id}>
      <tr style={{ cursor: 'pointer' }}>
        <td className="mono" onClick={() => toggle(t)} style={{ paddingLeft: 24 }}>
          <span className="muted">{expanded === t.id ? '▾' : '▸'}</span> {t.name}
        </td>
        <td onClick={() => toggle(t)}>
          <span className="pill">{t.kind}</span>
        </td>
        <td>
          <button className="ghost" onClick={() => patch(t.id, { visible: !t.visible })}>
            {t.visible ? '👁' : '🚫'}
          </button>
        </td>
        <td className="row">
          <button className="ghost" onClick={() => rename(t)}>
            Rename
          </button>
          <button className="danger" onClick={() => del(t.id)}>
            Delete
          </button>
        </td>
      </tr>
      {expanded === t.id && (
        <tr>
          <td colSpan={4}>
            <h3>Input schema (JSON)</h3>
            <div className="endpoint mono" style={{ maxHeight: 160, overflow: 'auto' }}>
              {JSON.stringify(t.inputSchema ?? { type: 'object', properties: {} }, null, 2)}
            </div>

            {t.kind === 'composite' && (
              <>
                <div className="spacer" />
                <h3>Definition (edit)</h3>
                <textarea value={editDef} onChange={(e) => setEditDef(e.target.value)} />
                <div className="spacer" />
                <button onClick={() => saveDef(t.id)}>Save definition</button>
              </>
            )}

            <div className="spacer" />
            <h3>Test run</h3>
            <div className="row">
              <input
                className="grow mono"
                placeholder='args JSON, e.g. {"petId":"1"}'
                value={testArgs}
                onChange={(e) => setTestArgs(e.target.value)}
              />
              <button onClick={() => test(t)}>Run</button>
            </div>
            {testOut && (
              <>
                {testOut.steps && testOut.steps.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    {testOut.steps.map((s) => (
                      <div key={s.id} style={{ marginBottom: 4 }}>
                        <span className="pill">{s.id}</span> <span className="mono">{s.tool}</span>{' '}
                        <span className={`badge ${s.isError ? 'err' : 'ok'}`}>
                          {s.skipped ? 'skip' : s.isError ? 'err' : 'ok'}
                        </span>
                        <div className="endpoint mono" style={{ marginTop: 2, maxHeight: 80, overflow: 'auto' }}>
                          {s.text || '(empty)'}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="spacer" />
                <div className="endpoint mono" style={{ maxHeight: 160, overflow: 'auto' }}>
                  {(testOut.isError ? '[error] ' : '') + (testOut.content?.[0]?.text ?? '')}
                </div>
              </>
            )}
          </td>
        </tr>
      )}
    </Frag>
  );

  return (
    <>
      <div className="intro">
        <b>Tools</b> — all tools from sources. <b>native</b> = one direct call (these appear after Import from a
        source — that's the "non-composite tool", pick any). <b>composite</b> = one tool that internally makes
        several calls.
        <br />
        Click a row → <b>tool JSON</b> (input schema), <b>Test</b> (see the response), for composite —{' '}
        <b>edit the definition</b>. For large APIs use the <b>search/filter</b> above the table.
      </div>

      <CompositeBuilder tools={tools} onCreated={load} />

      <div className="card">
        <h2>Tools registry ({filtered.length})</h2>
        {err && <div className="err-msg">{err}</div>}
        <div className="row" style={{ marginBottom: 10 }}>
          <input
            className="grow"
            placeholder="🔍 search by name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select value={fSource} onChange={(e) => setFSource(e.target.value)}>
            <option value="">all sources</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select value={fKind} onChange={(e) => setFKind(e.target.value)}>
            <option value="">all kinds</option>
            <option value="native">native</option>
            <option value="composite">composite</option>
          </select>
        </div>
        <table>
          <thead>
            <tr>
              <th>name</th>
              <th>kind</th>
              <th>visible</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sections.map((sec) => {
              const open = openSec.has(sec.key) || search.length > 0;
              const sel = sec.tools.length;
              return (
                <Frag key={sec.key}>
                  <tr className="sec-head" style={{ cursor: 'pointer' }} onClick={() => toggleSec(sec.key)}>
                    <td colSpan={4}>
                      <b>{open ? '▾' : '▸'} {sec.label}</b> <span className="muted">({sel})</span>
                    </td>
                  </tr>
                  {open && sec.tools.map(renderRow)}
                </Frag>
              );
            })}
            {!filtered.length && (
              <tr>
                <td colSpan={4} className="muted">
                  Nothing found. Import tools from a source (Sources tab).
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
