import { useEffect, useState, type ReactNode } from 'react';
import { api, type Source } from '../api.js';
import { SourceBuilder } from './SourceBuilder.js';

const hasInteractiveOAuth = (s: Source) =>
  ['oauth2_authorization_code', 'mcp_oauth'].includes(
    (s.config as { auth?: { type?: string } })?.auth?.type ?? '',
  );

function FragmentRow({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function SourcesTab() {
  const [sources, setSources] = useState<Source[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editCfg, setEditCfg] = useState('');

  const load = () => api.get<Source[]>('/sources').then(setSources).catch((e) => setErr(String(e.message)));
  useEffect(() => void load(), []);

  const act = async (id: string, what: 'test' | 'import' | 'del') => {
    setBusy(id + what);
    setErr('');
    try {
      if (what === 'del') await api.del(`/sources/${id}`);
      else await api.post(`/sources/${id}/${what}`);
      await load();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy('');
    }
  };

  const toggle = (s: Source) => {
    if (expanded === s.id) return setExpanded(null);
    setExpanded(s.id);
    setEditCfg(JSON.stringify(s.config, null, 2));
    setErr('');
  };

  const saveConfig = async (id: string) => {
    setErr('');
    try {
      await api.patch(`/sources/${id}`, { config: JSON.parse(editCfg) });
      await load();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const connect = async (id: string) => {
    try {
      const r = await api.get<{ url: string | null }>(`/sources/${id}/oauth/start`);
      if (r.url) window.open(r.url, '_blank');
      else setErr('Already connected (or no URL).');
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  return (
    <>
      <div className="intro">
        <b>Sources</b> — where tools come from. <b>mcp</b> = another MCP server · <b>openapi</b> = REST
        API from a spec · <b>http</b> = manual endpoints. Fill in the form (or switch to <b>JSON</b>) → Create → Test →
        Import. Tokens go through <b>Secrets</b> (<code>{'${secret.NAME}'}</code>), not in JSON. Click a row to
        edit.
      </div>

      <SourceBuilder onCreated={load} />

      <div className="card">
        <h2>Sources</h2>
        <div className="hint">Click a row to expand the JSON config for editing.</div>
        {err && <div className="err-msg">{err}</div>}
        <table>
          <thead>
            <tr>
              <th>name</th>
              <th>kind</th>
              <th>status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <FragmentRow key={s.id}>
                <tr style={{ cursor: 'pointer' }}>
                  <td onClick={() => toggle(s)}>
                    <span className="muted">{expanded === s.id ? '▾' : '▸'}</span> {s.name}
                  </td>
                  <td onClick={() => toggle(s)}>
                    <span className="pill">{s.kind}</span>
                  </td>
                  <td onClick={() => toggle(s)}>
                    <span
                      className={`badge ${s.status === 'ok' ? 'ok' : s.status === 'error' ? 'err' : 'muted'}`}
                    >
                      {s.status}
                    </span>
                    {s.statusMessage && <span className="muted"> {s.statusMessage}</span>}
                  </td>
                  <td className="row">
                    {hasInteractiveOAuth(s) && <button onClick={() => connect(s.id)}>Connect</button>}
                    <button className="ghost" onClick={() => act(s.id, 'test')} disabled={busy === s.id + 'test'}>
                      Test
                    </button>
                    <button className="ghost" onClick={() => act(s.id, 'import')} disabled={busy === s.id + 'import'}>
                      Import
                    </button>
                    <button className="danger" onClick={() => act(s.id, 'del')}>
                      Delete
                    </button>
                  </td>
                </tr>
                {expanded === s.id && (
                  <tr>
                    <td colSpan={4}>
                      <h3>Config JSON</h3>
                      <textarea value={editCfg} onChange={(e) => setEditCfg(e.target.value)} />
                      <div className="spacer" />
                      <button onClick={() => saveConfig(s.id)}>Save config</button>
                    </td>
                  </tr>
                )}
              </FragmentRow>
            ))}
            {!sources.length && (
              <tr>
                <td colSpan={4} className="muted">
                  No sources yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
