import { useState } from 'react';
import { api, type Tool } from '../api.js';

type Cfg = Record<string, any>;

const EMPTY = { steps: [{ id: 's1', tool: '', args: {} }], output: 'Result: ${$.steps.s1.text}' };

export function CompositeBuilder({ tools, onCreated }: { tools: Tool[]; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [def, setDef] = useState<Cfg>(EMPTY);
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [jsonText, setJsonText] = useState('');
  const [jsonErr, setJsonErr] = useState('');
  const [err, setErr] = useState('');

  const setStep = (i: number, patch: Cfg) =>
    setDef((d) => ({ ...d, steps: d.steps.map((s: Cfg, j: number) => (j === i ? { ...s, ...patch } : s)) }));

  const setArg = (i: number, k: string, v: string) =>
    setStep(i, { args: { ...def.steps[i].args, [k]: v } });
  const renameArg = (i: number, oldK: string, newK: string) => {
    const a = { ...def.steps[i].args };
    const val = a[oldK];
    delete a[oldK];
    if (newK) a[newK] = val;
    setStep(i, { args: a });
  };
  const delArg = (i: number, k: string) => {
    const a = { ...def.steps[i].args };
    delete a[k];
    setStep(i, { args: a });
  };

  const addStep = () =>
    setDef((d) => ({ ...d, steps: [...d.steps, { id: `s${d.steps.length + 1}`, tool: '', args: {} }] }));
  const delStep = (i: number) => setDef((d) => ({ ...d, steps: d.steps.filter((_: Cfg, j: number) => j !== i) }));

  const switchMode = (m: 'form' | 'json') => {
    if (m === 'json') {
      setJsonText(JSON.stringify(def, null, 2));
      setJsonErr('');
      setMode('json');
    } else {
      try {
        setDef(JSON.parse(jsonText));
        setJsonErr('');
        setMode('form');
      } catch (e) {
        setJsonErr('Invalid JSON: ' + (e as Error).message);
      }
    }
  };

  const onJson = (v: string) => {
    setJsonText(v);
    try {
      setDef(JSON.parse(v));
      setJsonErr('');
    } catch (e) {
      setJsonErr((e as Error).message);
    }
  };

  const create = async () => {
    setErr('');
    try {
      const definition = mode === 'json' ? JSON.parse(jsonText) : def;
      await api.post('/composite-tools', { name, definition });
      setName('');
      setDef(EMPTY);
      onCreated();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>New composite tool</h2>
        <div className="row" style={{ gap: 2 }}>
          <button className={mode === 'form' ? 'mini' : 'ghost mini'} onClick={() => switchMode('form')}>
            Form
          </button>
          <button className={mode === 'json' ? 'mini' : 'ghost mini'} onClick={() => switchMode('json')}>
            JSON
          </button>
        </div>
      </div>
      <div className="hint">One tool = a sequence of calls to other tools. Substitution: ${'{$.steps.ID.text}'} / ${'{$.input.x}'}.</div>

      <div className="spacer" />
      <input className="grow" style={{ width: '100%' }} placeholder="name (e.g. ops.report)" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="spacer" />

      {mode === 'json' ? (
        <>
          <textarea value={jsonText} onChange={(e) => onJson(e.target.value)} style={{ minHeight: 240 }} />
          {jsonErr && <div className="err-msg">{jsonErr}</div>}
        </>
      ) : (
        <div className="builder">
          {def.steps.map((s: Cfg, i: number) => (
            <div key={i} className="picker-group" style={{ padding: 10 }}>
              <div className="row">
                <input style={{ width: 70 }} placeholder="id" value={s.id} onChange={(e) => setStep(i, { id: e.target.value })} />
                <select className="grow" value={s.tool} onChange={(e) => setStep(i, { tool: e.target.value })}>
                  <option value="">— tool —</option>
                  {tools.map((t) => (
                    <option key={t.id} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <button className="danger mini" onClick={() => delStep(i)}>
                  ×
                </button>
              </div>
              <div className="spacer" />
              <Field label="when (opt.)" value={s.when ?? ''} onChange={(v) => setStep(i, { when: v || undefined })} placeholder="$.input.flag" />
              <div className="hint" style={{ marginTop: 6 }}>args</div>
              {Object.entries(s.args ?? {}).map(([k, v]) => (
                <div key={k} className="row" style={{ marginBottom: 4 }}>
                  <input style={{ width: 140 }} value={k} onChange={(e) => renameArg(i, k, e.target.value)} />
                  <input className="grow mono" value={String(v)} onChange={(e) => setArg(i, k, e.target.value)} placeholder='value or ${$.steps.s1.text}' />
                  <button className="danger mini" onClick={() => delArg(i, k)}>
                    ×
                  </button>
                </div>
              ))}
              <button className="ghost mini" onClick={() => setArg(i, `arg${Object.keys(s.args ?? {}).length + 1}`, '')}>
                + arg
              </button>
            </div>
          ))}
          <button className="ghost mini" onClick={addStep}>
            + step
          </button>

          <h3>Output (optional)</h3>
          <div className="hint">
            <b>text</b>: a string template, e.g. <code>{'Found: ${$.steps.s1.text}'}</code>.{' '}
            <b>json</b>: an object template → returned as <b>structured output</b> (describe it in Output schema below).
            Empty → raw result of the last step.
          </div>
          <OutputField value={def.output} onChange={(v) => setDef((d) => ({ ...d, output: v }))} />

          <h3>Input schema (JSON) — params the tool accepts</h3>
          <div className="hint">
            e.g. <code>{'{ "type":"object", "properties": { "from":{"type":"string"}, "to":{"type":"string"} } }'}</code> —
            reference values in steps as <code>$.input.from</code>.
          </div>
          <SchemaField value={def.inputSchema} onParsed={(v) => setDef((d) => ({ ...d, inputSchema: v }))} />

          <h3>Output schema (JSON, optional)</h3>
          <div className="hint">Describes the result so models parse it better. Leave empty to omit.</div>
          <SchemaField value={def.outputSchema} onParsed={(v) => setDef((d) => ({ ...d, outputSchema: v }))} />
        </div>
      )}

      <div className="spacer" />
      <button onClick={create} disabled={!name}>
        Create composite
      </button>
      {err && <div className="err-msg">{err}</div>}
    </div>
  );
}

/** JSON-schema textarea: parses to an object (or undefined when empty), shows
 *  a parse error inline. Keeps its own text so partial typing isn't lost. */
function SchemaField({ value, onParsed }: { value: unknown; onParsed: (v: Record<string, unknown> | undefined) => void }) {
  const [text, setText] = useState(value ? JSON.stringify(value, null, 2) : '');
  const [err, setErr] = useState('');
  const onChange = (v: string) => {
    setText(v);
    if (!v.trim()) {
      setErr('');
      onParsed(undefined);
      return;
    }
    try {
      onParsed(JSON.parse(v));
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <>
      <textarea value={text} onChange={(e) => onChange(e.target.value)} style={{ minHeight: 90 }} />
      {err && <div className="err-msg">{err}</div>}
    </>
  );
}

/** Output editor with text|json toggle. text → string template; json → object
 *  template (structured output). Emits undefined when empty. */
export function OutputField({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: string | Record<string, unknown> | undefined) => void;
}) {
  const initJson = value !== null && typeof value === 'object';
  const [mode, setMode] = useState<'text' | 'json'>(initJson ? 'json' : 'text');
  const [text, setText] = useState(
    value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  );
  const [err, setErr] = useState('');
  const emit = (t: string, m: 'text' | 'json') => {
    setText(t);
    if (!t.trim()) {
      setErr('');
      onChange(undefined);
      return;
    }
    if (m === 'text') {
      setErr('');
      onChange(t);
      return;
    }
    try {
      onChange(JSON.parse(t));
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const switchMode = (m: 'text' | 'json') => {
    setMode(m);
    emit(text, m);
  };
  return (
    <>
      <div className="row" style={{ gap: 2, marginBottom: 4 }}>
        <button className={mode === 'text' ? 'mini' : 'ghost mini'} onClick={() => switchMode('text')}>
          text
        </button>
        <button className={mode === 'json' ? 'mini' : 'ghost mini'} onClick={() => switchMode('json')}>
          json
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => emit(e.target.value, mode)}
        style={{ minHeight: 80 }}
        placeholder={mode === 'json' ? '{ "count": "${$.steps.s1.text}" }' : 'Result: ${$.steps.s1.text}'}
      />
      {err && <div className="err-msg">{err}</div>}
    </>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="builder-field">
      <span>{label}</span>
      <input value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
