import { useEffect, useState } from 'react';
import { api, type Secret } from '../api.js';

export function SecretsTab() {
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'value' | 'envRef'>('value');
  const [value, setValue] = useState('');
  const [err, setErr] = useState('');

  const load = () => api.get<Secret[]>('/secrets').then(setSecrets).catch((e) => setErr(String(e.message)));
  useEffect(() => void load(), []);

  const create = async () => {
    setErr('');
    try {
      const body = mode === 'value' ? { name, value } : { name, envRef: value };
      await api.post('/secrets', body);
      setName('');
      setValue('');
      await load();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const del = async (id: string) => {
    await api.del(`/secrets/${id}`).catch((e) => setErr(String(e.message)));
    await load();
  };

  return (
    <>
      <div className="intro">
        <b>Secrets</b> — tokens, keys, passwords. Stored encrypted (AES-256-GCM). In the source config you{' '}
        <b>don't write the value</b> — only a reference <code>{'${secret.NAME}'}</code>. At runtime comind substitutes
        the real value into the outgoing call; the agent and JSON config never see it.
        <br />
        <span className="muted">
          <b>value</b> — the value itself (encrypted). <b>envRef</b> — the name of a process env variable (the value is
          not stored in the DB).
        </span>
      </div>

      <div className="card">
        <h2>New secret</h2>
        <div className="hint">
          Name — uppercase Latin letters (e.g. <code>TITAN_TOKEN</code>). You'll reference it as <code>{'${secret.TITAN_TOKEN}'}</code>.
        </div>
        <div className="row">
          <input
            placeholder="NAME"
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
            style={{ width: 200 }}
          />
          <select value={mode} onChange={(e) => setMode(e.target.value as 'value' | 'envRef')}>
            <option value="value">value (encrypt)</option>
            <option value="envRef">envRef (env variable)</option>
          </select>
          <input
            className="grow"
            placeholder={mode === 'value' ? 'secret value' : 'ENV_VAR_NAME'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            type={mode === 'value' ? 'password' : 'text'}
          />
          <button onClick={create} disabled={!name || !value}>
            Create
          </button>
        </div>
        {err && <div className="err-msg">{err}</div>}
      </div>

      <div className="card">
        <h2>Secrets</h2>
        <table>
          <thead>
            <tr>
              <th>name</th>
              <th>scope</th>
              <th>reference</th>
              <th>type</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {secrets.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.displayName}</td>
                <td>
                  {s.sourceName ? (
                    <span className="pill">{s.sourceName}</span>
                  ) : (
                    <span className="badge muted">global</span>
                  )}
                </td>
                <td className="mono muted">{`\${secret.${s.name}}`}</td>
                <td>
                  <span className="pill">{s.kind}</span>
                  {s.envRef && <span className="muted"> ← {s.envRef}</span>}
                </td>
                <td>
                  <button className="danger" onClick={() => del(s.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {!secrets.length && (
              <tr>
                <td colSpan={5} className="muted">
                  No secrets yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
