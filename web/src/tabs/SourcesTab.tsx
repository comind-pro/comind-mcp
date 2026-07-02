import { useEffect, useState } from 'react';
import { api, type Source, type Tool } from '../api.js';
import { type Cfg, DEFAULTS, KIND_META, type Kind, SourceFields } from './SourceFields.js';

const KINDS: Kind[] = ['mcp', 'openapi', 'http', 'imap', 'sql', 'ga'];

const hasInteractiveOAuth = (cfg: Cfg) =>
  ['oauth2_authorization_code', 'mcp_oauth'].includes((cfg?.auth as { type?: string })?.type ?? '');

type PendingSecret = { name: string; mode: 'value' | 'envRef'; value: string };

interface Editing {
  id: string; // 'new' for a draft
  name: string;
  kind: Kind;
  cfg: Cfg;
  jsonRaw: string | null;
  jsonError: string | null;
  testState: 'idle' | 'testing' | 'ok' | 'error';
  testMsg: string;
  created: boolean;
  importedTools: Tool[] | null;
  secrets: PendingSecret[];
}

export function SourcesTab() {
  const [sources, setSources] = useState<Source[]>([]);
  const [err, setErr] = useState('');
  const [ed, setEd] = useState<Editing | null>(null);
  const [busy, setBusy] = useState('');

  const load = () =>
    api
      .get<Source[]>('/sources')
      .then(setSources)
      .catch((e) => setErr(String(e.message)));
  useEffect(() => void load(), []);

  const patch = (p: Partial<Editing>) => setEd((e) => (e ? { ...e, ...p } : e));
  const close = () => setEd(null);

  const openNew = () =>
    setEd({
      id: 'new',
      name: '',
      kind: 'mcp',
      cfg: DEFAULTS.mcp,
      jsonRaw: null,
      jsonError: null,
      testState: 'idle',
      testMsg: '',
      created: false,
      importedTools: null,
      secrets: [],
    });

  const openEdit = (s: Source) => {
    if (ed && ed.id === s.id) return close();
    setErr('');
    setEd({
      id: s.id,
      name: s.name,
      kind: s.kind as Kind,
      cfg: s.config as Cfg,
      jsonRaw: null,
      jsonError: null,
      testState: 'idle',
      testMsg: '',
      created: false,
      importedTools: null,
      secrets: [],
    });
  };

  const refreshObjects = async (id: string) => {
    setBusy('objects');
    setErr('');
    try {
      await api.post(`/sources/${id}/objects`);
      await load();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy('');
    }
  };

  // form → config (clears the raw JSON override so the pane re-derives)
  const setCfg = (next: Cfg) => patch({ cfg: next, jsonRaw: null, jsonError: null, testState: 'idle' });

  // JSON pane → config (two-way)
  const onJson = (text: string) => {
    try {
      const parsed = JSON.parse(text);
      patch({ cfg: parsed, jsonRaw: null, jsonError: null, testState: 'idle' });
    } catch (e) {
      patch({ jsonRaw: text, jsonError: (e as Error).message });
    }
  };

  const setKind = (k: Kind) => patch({ kind: k, cfg: DEFAULTS[k], jsonRaw: null, jsonError: null, testState: 'idle' });

  const buildConfig = (e: Editing): Cfg => {
    const config = { ...e.cfg };
    if (e.kind === 'imap' && !(config.smtp as Cfg)?.host) delete config.smtp; // read-only mailbox
    return config;
  };

  const createSource = async () => {
    if (!ed) return;
    setErr('');
    setBusy('create');
    try {
      const config = buildConfig(ed);
      const src = await api.post<{ id: string }>('/sources', { name: ed.name, kind: ed.kind, config });
      for (const s of ed.secrets) {
        if (!s.name || !s.value) continue;
        const b = s.mode === 'envRef' ? { name: s.name, envRef: s.value } : { name: s.name, value: s.value };
        await api.post('/secrets', { ...b, sourceId: src.id });
      }
      patch({ id: src.id, created: true, secrets: [] });
      await load();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy('');
    }
  };

  const saveExisting = async () => {
    if (!ed) return;
    setErr('');
    setBusy('save');
    try {
      await api.patch(`/sources/${ed.id}`, { name: ed.name, config: buildConfig(ed) });
      await load();
      close();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy('');
    }
  };

  const test = async () => {
    if (!ed) return;
    const isDraft = ed.id === 'new';
    patch({ testState: 'testing' });
    try {
      const pending: Record<string, string> = {};
      for (const s of ed.secrets) if (s.mode === 'value' && s.name && s.value) pending[s.name] = s.value;
      const r = isDraft
        ? await api.post<{ ok: boolean; message?: string }>('/sources/test', {
            name: ed.name || 'draft',
            kind: ed.kind,
            config: buildConfig(ed),
            secrets: pending,
          })
        : await api.post<{ ok: boolean; message?: string }>(`/sources/${ed.id}/test`);
      patch({ testState: r.ok ? 'ok' : 'error', testMsg: r.message ?? '' });
      if (!isDraft) await load();
    } catch (e) {
      patch({ testState: 'error', testMsg: String((e as Error).message) });
    }
  };

  const importTools = async (force = false) => {
    if (!ed || ed.id === 'new') return;
    setErr('');
    setBusy(force ? 'import-force' : 'import');
    try {
      const r = await api.post<{ imported: number; created: number; skipped: number; tools: Tool[] }>(
        `/sources/${ed.id}/import`,
        { force },
      );
      patch({ importedTools: r.tools });
      await load();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy('');
    }
  };

  const toggleToolVisible = async (t: Tool) => {
    patch({ importedTools: ed!.importedTools!.map((x) => (x.id === t.id ? { ...x, visible: !x.visible } : x)) });
    await api.patch(`/tools/${t.id}`, { visible: !t.visible }).catch((e) => setErr(String(e.message)));
  };

  const connect = async () => {
    if (!ed || ed.id === 'new') return;
    try {
      const r = await api.get<{ url: string | null }>(`/sources/${ed.id}/oauth/start`);
      if (r.url) window.open(r.url, '_blank');
      else setErr('Already connected (or no URL).');
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const del = async () => {
    if (!ed || ed.id === 'new') return;
    if (!confirm(`Delete source “${ed.name}”?`)) return;
    await api.del(`/sources/${ed.id}`).catch((e) => setErr(String(e.message)));
    await load();
    close();
  };

  const dotColor = (status: string) =>
    status === 'ok' ? 'var(--ok)' : status === 'error' ? 'var(--err)' : 'var(--muted)';

  const editor = (e: Editing, isNew: boolean) => {
    const jsonText = e.jsonRaw != null ? e.jsonRaw : JSON.stringify(e.cfg, null, 2);
    const interactive = hasInteractiveOAuth(e.cfg);
    return (
      <div className="editor-split">
        {/* LEFT: form */}
        <div className="editor-left">
          {e.created && e.importedTools && (
            <div style={{ marginBottom: 20 }}>
              <div className="status-line" style={{ color: 'var(--ok)', marginBottom: 10 }}>
                <span className="status-dot" style={{ background: 'var(--ok)' }} /> Imported — {e.importedTools.length}{' '}
                tools
              </div>
              <div className="hint">Toggle off to hide a tool from agents.</div>
              {e.importedTools.map((t) => (
                <div key={t.id} className="tool-check" onClick={() => toggleToolVisible(t)}>
                  <span className={`box ${t.visible ? 'on' : ''}`}>{t.visible ? '✓' : ''}</span>
                  <span className="mono" style={{ color: 'var(--accent)', fontSize: 13 }}>
                    {t.name}
                  </span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {t.description ?? ''}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="field-label">Name</div>
          <input
            style={{ width: '100%', marginBottom: 16 }}
            placeholder="e.g. app-db (no spaces)"
            value={e.name}
            onChange={(ev) => patch({ name: ev.target.value.replace(/\s+/g, '-') })}
          />

          {isNew && (
            <>
              <div className="field-label">Type</div>
              <div className="type-grid" style={{ marginBottom: 18 }}>
                {KINDS.map((k) => (
                  <div key={k} className={`type-card ${e.kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
                    <div style={{ flex: 1 }}>
                      <div className="tc-title">{KIND_META[k].title}</div>
                      <div className="tc-desc">{KIND_META[k].desc}</div>
                    </div>
                    <div className="tc-dot">{e.kind === k ? '✓' : ''}</div>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="editor-section">Connection</div>
          <SourceFields kind={e.kind} cfg={e.cfg} onChange={setCfg} />

          {isNew && (
            <div style={{ marginTop: 18 }}>
              <div className="editor-section">Secrets for this source</div>
              <div className="hint">
                Bound to this source (shown as <code>{e.name || 'source'}.NAME</code>). Reference in config as{' '}
                <code>{'${secret.NAME}'}</code>.
              </div>
              {e.secrets.map((s, i) => (
                <div key={i} className="row" style={{ marginBottom: 4 }}>
                  <input
                    style={{ width: 160 }}
                    placeholder="NAME"
                    value={s.name}
                    onChange={(ev) =>
                      patch({
                        secrets: e.secrets.map((x, j) =>
                          j === i ? { ...x, name: ev.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') } : x,
                        ),
                      })
                    }
                  />
                  <select
                    value={s.mode}
                    onChange={(ev) =>
                      patch({
                        secrets: e.secrets.map((x, j) =>
                          j === i ? { ...x, mode: ev.target.value as 'value' | 'envRef' } : x,
                        ),
                      })
                    }
                  >
                    <option value="value">value</option>
                    <option value="envRef">envRef</option>
                  </select>
                  <input
                    className="grow"
                    type={s.mode === 'value' ? 'password' : 'text'}
                    placeholder={s.mode === 'value' ? 'secret value' : 'ENV_VAR_NAME'}
                    value={s.value}
                    onChange={(ev) =>
                      patch({ secrets: e.secrets.map((x, j) => (j === i ? { ...x, value: ev.target.value } : x)) })
                    }
                  />
                  <button
                    className="danger mini"
                    onClick={() => patch({ secrets: e.secrets.filter((_, j) => j !== i) })}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                className="ghost mini"
                onClick={() => patch({ secrets: [...e.secrets, { name: 'API_TOKEN', mode: 'value', value: '' }] })}
              >
                + secret
              </button>
            </div>
          )}

          {/* objects: queryable entities inside the source (GA properties, DB schemas) */}
          {(!isNew || e.created) &&
            (() => {
              const objs = sources.find((s) => s.id === e.id)?.objects ?? [];
              return (
                <>
                  <div className="editor-section" style={{ marginTop: 18 }}>
                    Objects
                  </div>
                  <div className="hint">
                    Queryable entities inside this source (GA properties, DB schemas) — surfaced to agents via{' '}
                    <code className="mono">system.context</code>.
                  </div>
                  <div className="row" style={{ marginBottom: objs.length ? 8 : 0 }}>
                    <button className="ghost" onClick={() => refreshObjects(e.id)} disabled={busy === 'objects'}>
                      {busy === 'objects' ? 'Refreshing…' : 'Refresh objects'}
                    </button>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {objs.length} object{objs.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  {objs.map((o) => (
                    <div key={o.id} className="row" style={{ marginBottom: 4, alignItems: 'baseline' }}>
                      <span className="mono" style={{ fontSize: 12.5 }}>
                        {o.id}
                      </span>
                      <span className="muted" style={{ fontSize: 12 }}>
                        {o.name}
                        {o.product_hint ? ` · ${o.product_hint}` : ''}
                      </span>
                    </div>
                  ))}
                </>
              );
            })()}

          {/* actions */}
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }} className="row">
            {isNew && !e.created && (
              <button className="btn-primary" onClick={createSource} disabled={!e.name || !!busy}>
                {busy === 'create' ? 'Creating…' : 'Create source'}
              </button>
            )}
            {!isNew && (
              <button className="btn-primary" onClick={saveExisting} disabled={!!busy}>
                {busy === 'save' ? 'Saving…' : 'Save changes'}
              </button>
            )}
            <button className="ghost" onClick={test} disabled={e.testState === 'testing'}>
              {e.testState === 'testing' ? <span className="spin" /> : null} Test connection
            </button>
            {(!isNew || e.created) && (
              <>
                <button
                  className="ghost"
                  onClick={() => importTools(false)}
                  disabled={!!busy}
                  title="Create new tools only — leaves existing tools and your edits untouched"
                >
                  {busy === 'import' ? 'Importing…' : e.importedTools ? 'Import new tools' : 'Import tools →'}
                </button>
                <button
                  className="ghost"
                  onClick={() => importTools(true)}
                  disabled={!!busy}
                  title="Overwrite existing tools too — refreshes schemas & metadata from the source (discards manual edits)"
                >
                  {busy === 'import-force' ? 'Refreshing…' : 'Force re-import'}
                </button>
                {interactive && (
                  <button className="ghost" onClick={connect}>
                    Connect
                  </button>
                )}
              </>
            )}

            {e.testState === 'ok' && (
              <span className="status-line" style={{ color: 'var(--ok)' }}>
                <span className="status-dot" style={{ background: 'var(--ok)' }} /> connected
              </span>
            )}
            {e.testState === 'error' && (
              <span className="status-line" style={{ color: 'var(--err)' }}>
                <span className="status-dot" style={{ background: 'var(--err)' }} /> {e.testMsg || 'failed'}
              </span>
            )}

            {!isNew && (
              <button className="danger" style={{ marginLeft: 'auto' }} onClick={del}>
                Delete
              </button>
            )}
          </div>
          {err && <div className="err-msg">{err}</div>}
        </div>

        {/* RIGHT: JSON config */}
        <div className="editor-right">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <span className="field-label" style={{ margin: 0 }}>
              Config · JSON
            </span>
            <span className="tbadge">edits ↔ form</span>
          </div>
          <textarea
            className="json-area"
            spellCheck={false}
            value={jsonText}
            onChange={(ev) => onJson(ev.target.value)}
          />
          {e.jsonError ? (
            <div className="err-msg" style={{ marginTop: 8 }}>
              ⚠ {e.jsonError}
            </div>
          ) : (
            <div className="hint" style={{ marginTop: 8 }}>
              Edits here update the form. Secrets stay as references <code>{'${secret.NAME}'}</code>.
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="intro">
        <b>Sources</b> — where tools come from. Fill the form (or edit <b>JSON</b>) → Create → Test → Import. Tokens go
        through <b>Secrets</b> (<code>{'${secret.NAME}'}</code>), not in JSON. Click a row to edit.
      </div>

      <div className="page-head">
        <div>
          <span className="sub">{sources.length} connected</span>
        </div>
        <button className="btn-primary" onClick={openNew}>
          + New source
        </button>
      </div>

      {err && !ed && <div className="err-msg">{err}</div>}

      {/* draft card */}
      {ed && ed.id === 'new' && (
        <div className="scard open">
          <div className="scard-head" onClick={close}>
            <span className="name">{ed.name || 'New source'}</span>
            <span className="tbadge">{ed.kind}</span>
            <span className="chev up">⌄</span>
          </div>
          <div className="scard-body">{editor(ed, true)}</div>
        </div>
      )}

      {sources.map((s) => {
        const open = ed?.id === s.id;
        return (
          <div key={s.id} className={`scard ${open ? 'open' : ''}`}>
            <div className="scard-head" onClick={() => openEdit(s)}>
              <span className="name src-name">{s.name}</span>
              <span className="tbadge src-kind">{s.kind}</span>
              <span className="status-line src-status" style={{ color: dotColor(s.status) }}>
                <span className="status-dot" style={{ background: dotColor(s.status) }} /> {s.status}
              </span>
              <span style={{ marginLeft: 'auto' }} />
              <span className="edit-link">{open ? 'Close' : 'Edit'}</span>
              <span className={`chev ${open ? 'up' : ''}`}>⌄</span>
            </div>
            {s.status === 'error' && s.statusMessage && !open && <div className="src-err">{s.statusMessage}</div>}
            {open && ed && <div className="scard-body">{editor(ed, false)}</div>}
          </div>
        );
      })}

      {!sources.length && !ed && (
        <div className="muted" style={{ padding: '20px 2px' }}>
          No sources yet.
        </div>
      )}
    </>
  );
}
