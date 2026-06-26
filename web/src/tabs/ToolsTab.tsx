import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type Source, type Tool } from '../api.js';
import { CompositeBuilder, OutputField } from './CompositeBuilder.js';

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
  // native-tool edit buffers
  const [edName, setEdName] = useState('');
  const [edDisplay, setEdDisplay] = useState('');
  const [edDesc, setEdDesc] = useState('');
  const [edInput, setEdInput] = useState('');
  const [edOutput, setEdOutput] = useState('');
  const [edOut, setEdOut] = useState<unknown>(undefined); // composite output (string template | object)
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
    // common identity fields (both kinds, edited inline — no popup)
    setEdName(t.name);
    setEdDisplay(t.displayName ?? '');
    setEdDesc(t.description ?? '');
    if (t.kind === 'composite') {
      const full = await api.get<Tool & { definition: Record<string, unknown> }>(`/composite-tools/${t.id}`);
      // Split schemas/output out of the definition so they get their own fields;
      // the Definition textarea keeps steps/when only.
      const { inputSchema, outputSchema, output, ...rest } = full.definition ?? {};
      setEditDef(JSON.stringify(rest, null, 2));
      setEdInput(inputSchema ? JSON.stringify(inputSchema, null, 2) : '');
      setEdOutput(outputSchema ? JSON.stringify(outputSchema, null, 2) : '');
      setEdOut(output ?? undefined);
    } else {
      setEditDef('');
      setEdInput(JSON.stringify(t.inputSchema ?? { type: 'object', properties: {} }, null, 2));
      setEdOutput(t.outputSchema ? JSON.stringify(t.outputSchema, null, 2) : '');
    }
  };

  /** Save name/displayName/description (works for both kinds via /tools). */
  const saveIdentity = async (t: Tool) => {
    const body: Record<string, unknown> = { displayName: edDisplay || null, description: edDesc || null };
    if (edName && edName !== t.name) body.name = edName;
    await api.patch(`/tools/${t.id}`, body);
  };

  const saveNative = async (t: Tool) => {
    setErr('');
    const body: Record<string, unknown> = { displayName: edDisplay || null, description: edDesc || null };
    if (edName && edName !== t.name) body.name = edName;
    try {
      body.inputSchema = edInput.trim() ? JSON.parse(edInput) : null;
      body.outputSchema = edOutput.trim() ? JSON.parse(edOutput) : null;
    } catch (e) {
      return setErr('Invalid JSON in schema: ' + (e as Error).message);
    }
    await patch(t.id, body);
  };

  const saveDef = async (t: Tool) => {
    setErr('');
    try {
      const definition: Record<string, unknown> = JSON.parse(editDef);
      if (edInput.trim()) definition.inputSchema = JSON.parse(edInput);
      if (edOutput.trim()) definition.outputSchema = JSON.parse(edOutput);
      if (edOut !== undefined) definition.output = edOut;
      else delete definition.output; // empty → engine returns raw last step
      await saveIdentity(t); // name/displayName/description
      await api.patch(`/composite-tools/${t.id}`, { definition });
      await load();
    } catch (e) {
      setErr('Invalid JSON: ' + (e as Error).message);
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
          <button className="danger" onClick={() => del(t.id)}>
            Delete
          </button>
        </td>
      </tr>
      {expanded === t.id && (
        <tr>
          <td colSpan={4}>
            {/* Shared identity (both kinds, inline — no popup) */}
            <h3>Edit tool</h3>
            <label className="builder-field">
              <span>name (unique)</span>
              <input className="mono" value={edName} onChange={(e) => setEdName(e.target.value)} placeholder="registry key" />
            </label>
            <label className="builder-field">
              <span>display name</span>
              <input value={edDisplay} onChange={(e) => setEdDisplay(e.target.value)} placeholder="shown to agents" />
            </label>
            <label className="builder-field">
              <span>description</span>
              <input value={edDesc} onChange={(e) => setEdDesc(e.target.value)} placeholder="what the tool does" />
            </label>

            <h3>Input schema (JSON)</h3>
            {t.kind === 'composite' && (
              <div className="hint">
                Params the tool accepts. Use <code>$.input.x</code> in step args/sql params. Leave empty for none.
              </div>
            )}
            <textarea value={edInput} onChange={(e) => setEdInput(e.target.value)} style={{ minHeight: 110 }} />

            <h3>Output schema (JSON, optional)</h3>
            <div className="hint">Helps models parse the result. Leave empty to omit.</div>
            <textarea
              value={edOutput}
              onChange={(e) => setEdOutput(e.target.value)}
              style={{ minHeight: 90 }}
              placeholder='{ "type": "object", "properties": { ... } }'
            />

            {t.kind === 'composite' && (
              <>
                <h3>Output (optional)</h3>
                <div className="hint">
                  <b>text</b> = string template; <b>json</b> = object template → structured output (describe in Output
                  schema). Empty → raw result of the last step.
                </div>
                <OutputField value={edOut} onChange={setEdOut} />

                <h3>Definition (steps / when)</h3>
                <textarea value={editDef} onChange={(e) => setEditDef(e.target.value)} style={{ minHeight: 200 }} />
              </>
            )}

            <div className="spacer" />
            <button onClick={() => (t.kind === 'composite' ? saveDef(t) : saveNative(t))}>Save tool</button>

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
