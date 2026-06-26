import { useState } from 'react';
import { api } from '../api.js';

type Kind = 'mcp' | 'openapi' | 'http' | 'imap';
type Cfg = Record<string, any>;

const DEFAULTS: Record<Kind, Cfg> = {
  mcp: { url: '', transport: 'http' },
  openapi: { specUrl: '', baseUrl: '' },
  http: { baseUrl: '', endpoints: [{ name: '', method: 'GET', path: '' }] },
  imap: {
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 465, secure: true },
    user: '',
    pass: '${secret.MAIL_PASS}',
  },
};

const AUTH_DEFAULTS: Record<string, Cfg> = {
  basic: { type: 'basic', username: '${secret.USERNAME}', password: '${secret.PASSWORD}' },
  oauth2_client_credentials: { type: 'oauth2_client_credentials', tokenUrl: '', clientId: '', clientSecret: '${secret.CLIENT_SECRET}', scope: '' },
  token_request: { type: 'token_request', tokenUrl: '', method: 'POST', body: {}, tokenPath: '$.access_token', injectHeader: 'Authorization', injectPrefix: 'Bearer ' },
  oauth2_refresh: { type: 'oauth2_refresh', tokenUrl: '', clientId: '', refreshToken: '${secret.REFRESH_TOKEN}' },
  oauth2_authorization_code: { type: 'oauth2_authorization_code', authUrl: '', tokenUrl: '', clientId: '', clientSecret: '${secret.CLIENT_SECRET}', scope: '' },
  mcp_oauth: { type: 'mcp_oauth' },
};

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="builder-field">
      <span>{label}</span>
      <input value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function KvEditor({ obj, kv, valuePlaceholder }: { obj: Cfg; kv: any; valuePlaceholder?: string }) {
  return (
    <>
      {Object.entries(obj).map(([k, v]) => (
        <div key={k} className="row" style={{ marginBottom: 4 }}>
          <input style={{ width: 160 }} value={k} onChange={(e) => kv.rename(k, e.target.value)} />
          <input className="grow mono" value={String(v)} onChange={(e) => kv.set(k, e.target.value)} placeholder={valuePlaceholder} />
          <button className="danger mini" onClick={() => kv.del(k)}>
            ×
          </button>
        </div>
      ))}
      <button className="ghost mini" onClick={() => kv.add(`field${Object.keys(obj).length + 1}`)}>
        + field
      </button>
    </>
  );
}

export function SourceBuilder({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('mcp');
  const [cfg, setCfg] = useState<Cfg>(DEFAULTS.mcp);
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [jsonText, setJsonText] = useState('');
  const [jsonErr, setJsonErr] = useState('');
  const [err, setErr] = useState('');
  const [pendingSecrets, setPendingSecrets] = useState<{ name: string; mode: 'value' | 'envRef'; value: string }[]>([]);

  const setKindReset = (k: Kind) => {
    setKind(k);
    setCfg(DEFAULTS[k]);
  };

  const patch = (p: Cfg) => setCfg((c) => ({ ...c, ...p }));
  const setAuthField = (f: string, v: unknown) => setCfg((c) => ({ ...c, auth: { ...c.auth, [f]: v } }));

  const authType: string = cfg.auth?.type ?? (cfg.headers?.Authorization ? 'static' : 'none');
  const setAuthType = (t: string) => {
    setCfg((c) => {
      const { auth, ...rest } = c;
      if (t === 'none') {
        const h = { ...(rest.headers ?? {}) };
        delete h.Authorization;
        return { ...rest, ...(Object.keys(h).length ? { headers: h } : {}) };
      }
      if (t === 'static') {
        return { ...rest, headers: { ...(rest.headers ?? {}), Authorization: 'Bearer ${secret.API_TOKEN}' } };
      }
      return { ...rest, auth: AUTH_DEFAULTS[t] };
    });
  };

  // generic key-value editor over an object at cfg[path] or cfg.auth[path]
  const kvEdit = (obj: Cfg, set: (next: Cfg) => void) => ({
    set: (k: string, v: string) => set({ ...obj, [k]: v }),
    rename: (oldK: string, newK: string) => {
      const o = { ...obj };
      const val = o[oldK];
      delete o[oldK];
      if (newK) o[newK] = val;
      set(o);
    },
    del: (k: string) => {
      const o = { ...obj };
      delete o[k];
      set(o);
    },
    add: (k: string) => set({ ...obj, [k]: '' }),
  });

  const headers = cfg.headers ?? {};
  const headersKv = kvEdit(headers, (h) => patch(Object.keys(h).length ? { headers: h } : { headers: {} }));
  const body = cfg.auth?.body ?? {};
  const bodyKv = kvEdit(body, (b) => setAuthField('body', b));

  const switchMode = (m: 'form' | 'json') => {
    if (m === 'json') {
      setJsonText(JSON.stringify(cfg, null, 2));
      setJsonErr('');
      setMode('json');
    } else {
      try {
        setCfg(JSON.parse(jsonText));
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
      setCfg(JSON.parse(v));
      setJsonErr('');
    } catch (e) {
      setJsonErr((e as Error).message);
    }
  };

  const create = async () => {
    setErr('');
    try {
      const config = mode === 'json' ? JSON.parse(jsonText) : { ...cfg };
      // imap: drop an empty SMTP block (sending optional → read-only mailbox)
      if (kind === 'imap' && !config.smtp?.host) delete config.smtp;
      const src = await api.post<{ id: string }>('/sources', { name, kind, config });
      // create source-scoped secrets defined inline in the wizard
      for (const s of pendingSecrets) {
        if (!s.name || !s.value) continue;
        const body = s.mode === 'envRef' ? { name: s.name, envRef: s.value } : { name: s.name, value: s.value };
        await api.post('/secrets', { ...body, sourceId: src.id });
      }
      setName('');
      setKindReset('mcp');
      setPendingSecrets([]);
      onCreated();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const setSecret = (i: number, patch: Partial<{ name: string; mode: 'value' | 'envRef'; value: string }>) =>
    setPendingSecrets((ps) => ps.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  // static-token secret name parsed from header
  const staticName = (() => {
    const m = /\$\{secret\.([A-Za-z0-9_]+)\}/.exec(cfg.headers?.Authorization ?? '');
    return m?.[1] ?? 'API_TOKEN';
  })();

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>New source</h2>
        <div className="row" style={{ gap: 2 }}>
          <button className={mode === 'form' ? 'mini' : 'ghost mini'} onClick={() => switchMode('form')}>
            Form
          </button>
          <button className={mode === 'json' ? 'mini' : 'ghost mini'} onClick={() => switchMode('json')}>
            JSON
          </button>
        </div>
      </div>

      <div className="spacer" />
      <div className="row">
        <input
          className="grow"
          placeholder="name (no spaces — auto → -)"
          value={name}
          onChange={(e) => setName(e.target.value.replace(/\s+/g, '-'))}
        />
        <select value={kind} onChange={(e) => setKindReset(e.target.value as Kind)}>
          <option value="mcp">mcp proxy</option>
          <option value="openapi">openapi</option>
          <option value="http">http</option>
          <option value="imap">email (imap/smtp)</option>
        </select>
      </div>
      <div className="spacer" />

      {mode === 'json' ? (
        <>
          <textarea value={jsonText} onChange={(e) => onJson(e.target.value)} style={{ minHeight: 220 }} />
          {jsonErr && <div className="err-msg">{jsonErr}</div>}
        </>
      ) : (
        <div className="builder">
          {kind === 'mcp' && (
            <>
              <Field label="MCP URL" value={cfg.url} onChange={(v) => patch({ url: v })} placeholder="https://api.example.com/mcp" />
              <label className="builder-field">
                <span>transport</span>
                <select value={cfg.transport ?? 'http'} onChange={(e) => patch({ transport: e.target.value })}>
                  <option value="http">http (Streamable)</option>
                  <option value="sse">sse</option>
                </select>
              </label>
            </>
          )}
          {kind === 'openapi' && (
            <>
              <Field label="OpenAPI spec URL" value={cfg.specUrl} onChange={(v) => patch({ specUrl: v })} placeholder="https://api.example.com/openapi.json" />
              <Field label="Base URL (optional)" value={cfg.baseUrl} onChange={(v) => patch({ baseUrl: v })} placeholder="https://api.example.com" />
              <div className="hint">Set an inline spec (without a URL) in JSON mode.</div>
            </>
          )}
          {kind === 'http' && (
            <>
              <Field label="Base URL" value={cfg.baseUrl} onChange={(v) => patch({ baseUrl: v })} placeholder="https://api.example.com" />
              <Field label="Health path (optional)" value={cfg.healthPath} onChange={(v) => patch({ healthPath: v })} placeholder="/health" />
              <h3>Endpoints</h3>
              {(cfg.endpoints ?? []).map((ep: Cfg, i: number) => (
                <div key={i} className="row" style={{ marginBottom: 4 }}>
                  <input style={{ width: 120 }} placeholder="name" value={ep.name} onChange={(e) => patch({ endpoints: cfg.endpoints.map((x: Cfg, j: number) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                  <select value={ep.method} onChange={(e) => patch({ endpoints: cfg.endpoints.map((x: Cfg, j: number) => (j === i ? { ...x, method: e.target.value } : x)) })}>
                    {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                  <input className="grow" placeholder="/path/{id}" value={ep.path} onChange={(e) => patch({ endpoints: cfg.endpoints.map((x: Cfg, j: number) => (j === i ? { ...x, path: e.target.value } : x)) })} />
                  <button className="danger mini" onClick={() => patch({ endpoints: cfg.endpoints.filter((_: Cfg, j: number) => j !== i) })}>
                    ×
                  </button>
                </div>
              ))}
              <button className="ghost mini" onClick={() => patch({ endpoints: [...(cfg.endpoints ?? []), { name: '', method: 'GET', path: '' }] })}>
                + endpoint
              </button>
            </>
          )}

          {kind === 'imap' && (
            <>
              <h3>IMAP (incoming)</h3>
              <Field label="IMAP host" value={cfg.imap?.host} onChange={(v) => patch({ imap: { ...cfg.imap, host: v } })} placeholder="imap.titan.email" />
              <Field label="IMAP port" value={String(cfg.imap?.port ?? '')} onChange={(v) => patch({ imap: { ...cfg.imap, port: Number(v) || undefined } })} placeholder="993" />
              <h3>SMTP (outgoing) — optional</h3>
              <div className="hint">Leave SMTP host empty for a read-only mailbox (no send_message tool).</div>
              <Field label="SMTP host" value={cfg.smtp?.host} onChange={(v) => patch({ smtp: { ...cfg.smtp, host: v } })} placeholder="smtp.titan.email" />
              <Field label="SMTP port" value={String(cfg.smtp?.port ?? '')} onChange={(v) => patch({ smtp: { ...cfg.smtp, port: Number(v) || undefined } })} placeholder="465" />
              <h3>Credentials</h3>
              <Field label="User (email)" value={cfg.user} onChange={(v) => patch({ user: v })} placeholder="you@domain.com" />
              <Field label="Password (secret ref)" value={cfg.pass} onChange={(v) => patch({ pass: v })} placeholder="${secret.MAIL_PASS}" />
              <div className="hint">
                Use an app password. Add it under “Secrets for this source” below as <code>MAIL_PASS</code> and keep the
                reference <code>{'${secret.MAIL_PASS}'}</code> here.
              </div>
            </>
          )}

          {kind !== 'imap' && (
          <>
          <h3>Authorization</h3>
          <label className="builder-field">
            <span>type</span>
            <select value={authType} onChange={(e) => setAuthType(e.target.value)}>
              <option value="none">none</option>
              <option value="static">static token (header)</option>
              <option value="basic">basic (username/password)</option>
              <option value="oauth2_client_credentials">oauth2_client_credentials</option>
              <option value="token_request">token_request (login→token)</option>
              <option value="oauth2_refresh">oauth2_refresh</option>
              <option value="oauth2_authorization_code">oauth2_authorization_code (user)</option>
              <option value="mcp_oauth">mcp_oauth (remote MCP)</option>
            </select>
          </label>

          {authType === 'static' && (
            <Field
              label="Secret name"
              value={staticName}
              onChange={(v) => patch({ headers: { ...cfg.headers, Authorization: `Bearer \${secret.${v || 'API_TOKEN'}}` } })}
              placeholder="API_TOKEN"
            />
          )}
          {authType === 'basic' && (
            <>
              <Field label="Username" value={cfg.auth.username} onChange={(v) => setAuthField('username', v)} placeholder="${secret.USERNAME}" />
              <Field label="Password" value={cfg.auth.password} onChange={(v) => setAuthField('password', v)} placeholder="${secret.PASSWORD}" />
              <Field label="Header name (optional)" value={cfg.auth.header ?? ''} onChange={(v) => setAuthField('header', v || undefined)} placeholder="Authorization" />
              <div className="hint">→ <code>Authorization: Basic base64(user:pass)</code>. Take values from Secrets.</div>
            </>
          )}
          {(authType === 'oauth2_client_credentials' || authType === 'oauth2_refresh' || authType === 'oauth2_authorization_code') && (
            <>
              {authType === 'oauth2_authorization_code' && <Field label="Authorize URL" value={cfg.auth.authUrl} onChange={(v) => setAuthField('authUrl', v)} />}
              <Field label="Token URL" value={cfg.auth.tokenUrl} onChange={(v) => setAuthField('tokenUrl', v)} />
              <Field label="Client ID" value={cfg.auth.clientId} onChange={(v) => setAuthField('clientId', v)} />
              {authType !== 'oauth2_refresh' && <Field label="Client secret" value={cfg.auth.clientSecret} onChange={(v) => setAuthField('clientSecret', v)} placeholder="${secret.CLIENT_SECRET}" />}
              {authType === 'oauth2_refresh' && <Field label="Refresh token" value={cfg.auth.refreshToken} onChange={(v) => setAuthField('refreshToken', v)} placeholder="${secret.REFRESH_TOKEN}" />}
              <Field label="Scope (optional)" value={cfg.auth.scope} onChange={(v) => setAuthField('scope', v)} />
            </>
          )}
          {authType === 'token_request' && (
            <>
              <Field label="Login URL" value={cfg.auth.tokenUrl} onChange={(v) => setAuthField('tokenUrl', v)} />
              <Field label="Token JSON-path" value={cfg.auth.tokenPath} onChange={(v) => setAuthField('tokenPath', v)} placeholder="$.data.token" />
              <Field label="Inject header" value={cfg.auth.injectHeader} onChange={(v) => setAuthField('injectHeader', v)} placeholder="Authorization" />
              <Field label="Inject prefix" value={cfg.auth.injectPrefix} onChange={(v) => setAuthField('injectPrefix', v)} placeholder="Bearer " />
              <div className="hint" style={{ marginTop: 6 }}>Body (login payload — custom field names)</div>
              <KvEditor obj={body} kv={bodyKv} valuePlaceholder="${secret.PASSWORD} or value" />
            </>
          )}
          {authType === 'mcp_oauth' && (
            <>
              <Field label="Client ID (optional, for servers without DCR — Titan: claude)" value={cfg.auth.clientId ?? ''} onChange={(v) => setAuthField('clientId', v || undefined)} placeholder="claude" />
              <div className="hint">User-OAuth remote MCP. After Create → Connect button.</div>
            </>
          )}

          <h3>Custom headers</h3>
          <div className="hint">Arbitrary headers with custom names (e.g. <code>X-Api-Key: {'${secret.KEY}'}</code>). Suitable for static tokens.</div>
          <KvEditor obj={headers} kv={headersKv} valuePlaceholder="${secret.API_TOKEN} / value" />
          </>
          )}
        </div>
      )}

      <div className="spacer" />
      <div className="builder">
        <h3>Secrets for this source</h3>
        <div className="hint">
          Create secrets right here — they'll be bound to this source (on the Secrets page they'll appear as{' '}
          <code>{name || 'source'}.NAME</code>). Reference them in the config as <code>{'${secret.NAME}'}</code>. If a
          global one with the same name exists, this will override it for this source.
        </div>
        {pendingSecrets.map((s, i) => (
          <div key={i} className="row" style={{ marginBottom: 4 }}>
            <input
              style={{ width: 170 }}
              placeholder="NAME"
              value={s.name}
              onChange={(e) => setSecret(i, { name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })}
            />
            <select value={s.mode} onChange={(e) => setSecret(i, { mode: e.target.value as 'value' | 'envRef' })}>
              <option value="value">value</option>
              <option value="envRef">envRef</option>
            </select>
            <input
              className="grow"
              type={s.mode === 'value' ? 'password' : 'text'}
              placeholder={s.mode === 'value' ? 'secret value' : 'ENV_VAR_NAME'}
              value={s.value}
              onChange={(e) => setSecret(i, { value: e.target.value })}
            />
            <button className="danger mini" onClick={() => setPendingSecrets((ps) => ps.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
        ))}
        <button className="ghost mini" onClick={() => setPendingSecrets((ps) => [...ps, { name: 'API_TOKEN', mode: 'value', value: '' }])}>
          + secret
        </button>
      </div>

      <div className="spacer" />
      <button onClick={create} disabled={!name}>
        Create source
      </button>
      {err && <div className="err-msg">{err}</div>}
    </div>
  );
}
