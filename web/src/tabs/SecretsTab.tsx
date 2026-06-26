import { useEffect, useState } from 'react';
import { api, type Secret } from '../api.js';

export function SecretsTab() {
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'value' | 'envRef'>('value');
  const [value, setValue] = useState('');
  const [err, setErr] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editVal, setEditVal] = useState('');

  const load = () => api.get<Secret[]>('/secrets').then(setSecrets).catch((e) => setErr(String(e.message)));
  useEffect(() => void load(), []);

  const startEdit = (s: Secret) => {
    setEditId(s.id);
    // env: prefill with the env var name (not secret). encrypted: blind — start empty.
    setEditVal(s.kind === 'env' ? s.envRef ?? '' : '');
    setErr('');
  };

  const saveEdit = async (s: Secret) => {
    setErr('');
    try {
      const body = s.kind === 'env' ? { envRef: editVal } : { value: editVal };
      await api.patch(`/secrets/${s.id}`, body);
      setEditId(null);
      setEditVal('');
      await load();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

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
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            name="comind-secret-name"
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
            autoComplete={mode === 'value' ? 'new-password' : 'off'}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            name="comind-secret-value"
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
                  {s.envRef && editId !== s.id && <span className="muted"> ← {s.envRef}</span>}
                </td>
                <td>
                  {editId === s.id ? (
                    <div className="row" style={{ gap: 4 }}>
                      <input
                        className="grow"
                        autoFocus
                        type={s.kind === 'env' ? 'text' : 'password'}
                        placeholder={s.kind === 'env' ? 'ENV_VAR_NAME' : 'new value (current hidden)'}
                        value={editVal}
                        onChange={(e) => setEditVal(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && saveEdit(s)}
                        autoComplete={s.kind === 'env' ? 'off' : 'new-password'}
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        name="comind-secret-edit"
                      />
                      <button className="mini" onClick={() => saveEdit(s)} disabled={!editVal}>
                        Save
                      </button>
                      <button className="ghost mini" onClick={() => setEditId(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="row" style={{ gap: 4 }}>
                      <button className="ghost mini" onClick={() => startEdit(s)}>
                        Edit
                      </button>
                      <button className="danger mini" onClick={() => del(s.id)}>
                        Delete
                      </button>
                    </div>
                  )}
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
