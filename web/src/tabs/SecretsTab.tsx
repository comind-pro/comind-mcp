import { useEffect, useState } from 'react';
import { api, type Secret } from '../api.js';

export function SecretsTab() {
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [draft, setDraft] = useState(false);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'value' | 'envRef'>('value');
  const [value, setValue] = useState('');
  const [err, setErr] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editVal, setEditVal] = useState('');

  const load = () =>
    api
      .get<Secret[]>('/secrets')
      .then(setSecrets)
      .catch((e) => setErr(String(e.message)));
  useEffect(() => void load(), []);

  const startEdit = (s: Secret) => {
    setEditId(s.id);
    setEditVal(s.kind === 'env' ? (s.envRef ?? '') : '');
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
      setDraft(false);
      await load();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const del = async (id: string) => {
    if (!confirm('Delete this secret?')) return;
    await api.del(`/secrets/${id}`).catch((e) => setErr(String(e.message)));
    await load();
  };

  return (
    <>
      <div className="intro">
        <b>Secrets</b> — tokens, keys, passwords. Stored encrypted (AES-256-GCM). In a source config you write only a
        reference <code>{'${secret.NAME}'}</code>; at runtime comind substitutes the real value — the agent and JSON
        never see it. <b>value</b> = encrypted value · <b>envRef</b> = name of a process env variable.
      </div>

      <div className="page-head">
        <div>
          <span className="sub">{secrets.length} stored</span>
        </div>
        <button className="btn-primary" onClick={() => setDraft(!draft)}>
          + New secret
        </button>
      </div>

      {err && !draft && <div className="err-msg">{err}</div>}

      {draft && (
        <div className="scard open">
          <div className="scard-body">
            <div className="editor-left" style={{ borderRight: 'none' }}>
              <div className="field-label">Name · uppercase Latin (e.g. TITAN_TOKEN)</div>
              <div className="row">
                <input
                  className="mono"
                  style={{ width: 220 }}
                  placeholder="NAME"
                  value={name}
                  onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
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
                <button className="btn-primary" onClick={create} disabled={!name || !value}>
                  Create
                </button>
                <button className="ghost" onClick={() => setDraft(false)}>
                  Cancel
                </button>
              </div>
              <div className="hint">
                Reference it in configs as <code>{`\${secret.${name || 'NAME'}}`}</code>.
              </div>
              {err && <div className="err-msg">{err}</div>}
            </div>
          </div>
        </div>
      )}

      <div className="card">
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
                    <span className="tbadge">{s.sourceName}</span>
                  ) : (
                    <span className="badge muted">global</span>
                  )}
                </td>
                <td className="mono muted">{`\${secret.${s.name}}`}</td>
                <td>
                  <span className="tbadge">{s.kind}</span>
                  {s.envRef && editId !== s.id && <span className="muted"> ← {s.envRef}</span>}
                </td>
                <td>
                  {editId === s.id ? (
                    <div className="row" style={{ gap: 4 }}>
                      <input
                        className="grow"
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
