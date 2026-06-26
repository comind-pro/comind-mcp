import type { ReactNode } from 'react';

export type Kind = 'mcp' | 'openapi' | 'http' | 'imap' | 'sql';
export type Cfg = Record<string, any>;

export const KIND_META: Record<Kind, { title: string; desc: string }> = {
  mcp: { title: 'MCP server', desc: 'Wrap a remote MCP' },
  openapi: { title: 'OpenAPI', desc: 'REST from a spec' },
  http: { title: 'HTTP API', desc: 'Manual endpoints' },
  imap: { title: 'Email', desc: 'IMAP / SMTP' },
  sql: { title: 'SQL database', desc: 'Postgres · read-only' },
};

export const DEFAULTS: Record<Kind, Cfg> = {
  mcp: { url: '', transport: 'http' },
  openapi: { specUrl: '', baseUrl: '' },
  http: { baseUrl: '', endpoints: [{ name: '', method: 'GET', path: '' }] },
  imap: {
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 465, secure: true },
    user: '',
    pass: '${secret.MAIL_PASS}',
  },
  sql: { url: '${secret.DB_URL}', schema: 'public', maxRows: 1000 },
};

const AUTH_DEFAULTS: Record<string, Cfg> = {
  basic: { type: 'basic', username: '${secret.USERNAME}', password: '${secret.PASSWORD}' },
  oauth2_client_credentials: { type: 'oauth2_client_credentials', tokenUrl: '', clientId: '', clientSecret: '${secret.CLIENT_SECRET}', scope: '' },
  token_request: { type: 'token_request', tokenUrl: '', method: 'POST', body: {}, tokenPath: '$.access_token', injectHeader: 'Authorization', injectPrefix: 'Bearer ' },
  oauth2_refresh: { type: 'oauth2_refresh', tokenUrl: '', clientId: '', refreshToken: '${secret.REFRESH_TOKEN}' },
  oauth2_authorization_code: { type: 'oauth2_authorization_code', authUrl: '', tokenUrl: '', clientId: '', clientSecret: '${secret.CLIENT_SECRET}', scope: '' },
  mcp_oauth: { type: 'mcp_oauth' },
};

export function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
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

/** Per-kind connection form + authorization. Edits the whole config object via onChange. */
export function SourceFields({ kind, cfg, onChange }: { kind: Kind; cfg: Cfg; onChange: (next: Cfg) => void }): ReactNode {
  const patch = (p: Cfg) => onChange({ ...cfg, ...p });
  const setAuthField = (f: string, v: unknown) => onChange({ ...cfg, auth: { ...cfg.auth, [f]: v } });

  const authType: string = cfg.auth?.type ?? (cfg.headers?.Authorization ? 'static' : 'none');
  const setAuthType = (t: string) => {
    const { auth, ...rest } = cfg;
    if (t === 'none') {
      const h = { ...(rest.headers ?? {}) };
      delete h.Authorization;
      onChange({ ...rest, ...(Object.keys(h).length ? { headers: h } : {}) });
    } else if (t === 'static') {
      onChange({ ...rest, headers: { ...(rest.headers ?? {}), Authorization: 'Bearer ${secret.API_TOKEN}' } });
    } else {
      onChange({ ...rest, auth: AUTH_DEFAULTS[t] });
    }
  };

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

  const staticName = (() => {
    const m = /\$\{secret\.([A-Za-z0-9_]+)\}/.exec(cfg.headers?.Authorization ?? '');
    return m?.[1] ?? 'API_TOKEN';
  })();

  return (
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
            Use an app password. Add it under “Secrets for this source” as <code>MAIL_PASS</code> and keep the
            reference <code>{'${secret.MAIL_PASS}'}</code> here.
          </div>
        </>
      )}

      {kind === 'sql' && (
        <>
          <Field label="Connection URL" value={cfg.url} onChange={(v) => patch({ url: v })} placeholder="${secret.DB_URL}" />
          <Field label="Schema" value={cfg.schema} onChange={(v) => patch({ schema: v })} placeholder="public" />
          <Field label="Max rows" value={String(cfg.maxRows ?? '')} onChange={(v) => patch({ maxRows: Number(v) || undefined })} placeholder="1000" />
          <div className="hint">
            Postgres only, <b>read-only</b> (every query runs in a READ ONLY transaction). Store the connection string
            as a Secret <code>DB_URL</code> and keep <code>{'${secret.DB_URL}'}</code> here. Tools: list_tables,
            describe_table, run_query.
          </div>
        </>
      )}

      {kind !== 'imap' && kind !== 'sql' && (
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
              <Field label="Client ID (optional — Titan: claude)" value={cfg.auth.clientId ?? ''} onChange={(v) => setAuthField('clientId', v || undefined)} placeholder="claude" />
              <div className="hint">User-OAuth remote MCP. After Create → Connect button.</div>
            </>
          )}

          <h3>Custom headers</h3>
          <div className="hint">Arbitrary headers (e.g. <code>X-Api-Key: {'${secret.KEY}'}</code>). Suitable for static tokens.</div>
          <KvEditor obj={headers} kv={headersKv} valuePlaceholder="${secret.API_TOKEN} / value" />
        </>
      )}
    </div>
  );
}
