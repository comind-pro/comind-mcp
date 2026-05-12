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

          <h3>Output template</h3>
          <textarea value={def.output ?? ''} onChange={(e) => setDef((d) => ({ ...d, output: e.target.value }))} style={{ minHeight: 70 }} />
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

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="builder-field">
      <span>{label}</span>
      <input value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
