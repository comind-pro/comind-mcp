import { type ReactNode, useState } from 'react';
import { type AuthUser, api } from './api.js';

const STEPS = [
  [
    'Connect sources',
    'Add any MCP server or HTTP/OpenAPI API. comind-mcp introspects it and lists every tool it exposes.',
  ],
  [
    'Curate tools',
    'Pick the tools that matter, rename them, tweak schemas, or merge several calls into one composite tool.',
  ],
  [
    'Build a workspace',
    'Bundle the curated tools into a workspace — a single clean endpoint that hides the messy upstreams.',
  ],
  [
    'Grant agents',
    'Issue per-agent keys with scoped access to specific workspaces. Rotate or revoke any key instantly.',
  ],
  [
    'Observe',
    'Every call is logged: which agent, which tool, latency, errors. Schedule jobs and store secrets in the vault.',
  ],
] as const;

// crisp UI mock — looks like a screenshot, rendered from markup (no images)
function Shot({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="shot">
      <div className="shot-bar">
        <span className="shot-dot" />
        <span className="shot-dot" />
        <span className="shot-dot" />
        <span className="shot-title">{title}</span>
      </div>
      <div className="shot-body">{children}</div>
    </div>
  );
}

function SourcesShot() {
  return (
    <Shot title="Sources">
      <div className="shot-row">
        <span className="shot-status ok" /> github-mcp <span className="shot-badge">12 tools</span>
      </div>
      <div className="shot-row">
        <span className="shot-status ok" /> stripe (OpenAPI) <span className="shot-badge">8 tools</span>
      </div>
      <div className="shot-row">
        <span className="shot-status ok" /> internal-crm <span className="shot-badge">5 tools</span>
      </div>
      <div className="shot-row muted">+ Add source — MCP / HTTP / OpenAPI</div>
    </Shot>
  );
}

function VmcpShot() {
  return (
    <Shot title="Workspace · support-bot">
      <div className="shot-row">
        <input type="checkbox" checked readOnly /> github.create_issue
      </div>
      <div className="shot-row">
        <input type="checkbox" checked readOnly /> stripe.refund_charge
      </div>
      <div className="shot-row">
        <input type="checkbox" checked readOnly /> crm.lookup_customer
      </div>
      <div className="shot-endpoint">https://mcp.comind.pro/g/support-bot</div>
    </Shot>
  );
}

function AgentsShot() {
  return (
    <Shot title="Agents">
      <div className="shot-row">
        🤖 claude-support <span className="shot-badge">support-bot</span>
      </div>
      <div className="shot-endpoint">key: ag_live_••••••••3f9a</div>
      <div className="shot-row">
        🤖 ops-runner <span className="shot-badge">internal-tools</span>
      </div>
      <div className="shot-endpoint">key: ag_live_••••••••b71c</div>
    </Shot>
  );
}

export function AuthPage({ onAuth }: { onAuth: (u: AuthUser) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      const user = mode === 'login' ? await api.login(email, password) : await api.register(email, password);
      onAuth(user);
    } catch (e) {
      const m = String((e as Error).message);
      setErr(
        m === 'invalid_credentials'
          ? 'Invalid email or password'
          : m === 'email_taken'
            ? 'Email already registered'
            : m,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="landing">
      {/* hero: description + auth form */}
      <section className="landing-hero">
        <div className="landing-copy">
          <div className="landing-top">
            <span className="brand landing-brand">comind-mcp</span>
            <a className="landing-gh" href="https://github.com/comind-pro/comind-mcp" target="_blank" rel="noreferrer">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
              </svg>
              GitHub
            </a>
          </div>
          <h1 className="landing-h1">One gateway for all your MCP tools.</h1>
          <p className="landing-tagline">
            Agents shouldn't juggle a dozen MCP servers and APIs. comind-mcp <b>aggregates</b> them, lets you{' '}
            <b>curate &amp; combine</b> the tools, and exposes <b>curated virtual MCP endpoints</b> your agents can call
            — with per-agent keys, secrets vault, schedules and full logs. Self-hosted, zero-infra.
          </p>
          <div className="landing-flow">
            {STEPS.map(([s], i) => (
              <span key={s} className="landing-flow-step">
                <b>{s}</b>
                {i < STEPS.length - 1 && <span className="arrow"> → </span>}
              </span>
            ))}
          </div>
        </div>

        <div className="landing-auth">
          <div className="card" style={{ width: 360 }}>
            <div className="brand" style={{ marginBottom: 4 }}>
              {mode === 'login' ? 'Welcome back' : 'Create your account'}
            </div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 16 }}>
              {mode === 'login' ? 'Sign in to your gateway' : 'Start aggregating in seconds'}
            </div>
            <div className="auth-form">
              <input placeholder="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <input
                placeholder="password (8+ characters)"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
              {err && <div className="err-msg">{err}</div>}
              <button onClick={submit} disabled={busy || !email || password.length < 8}>
                {mode === 'login' ? 'Sign in' : 'Sign up'}
              </button>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 12, textAlign: 'center' }}>
              {mode === 'login' ? 'No account?' : 'Already have an account?'}{' '}
              <a
                style={{ cursor: 'pointer' }}
                onClick={() => {
                  setMode(mode === 'login' ? 'register' : 'login');
                  setErr('');
                }}
              >
                {mode === 'login' ? 'Sign up' : 'Sign in'}
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* product preview */}
      <section className="landing-section">
        <h2 className="landing-h2">What it looks like</h2>
        <p className="landing-sub">
          Connect raw sources on the left, shape them into a clean workspace in the middle, hand scoped keys to agents
          on the right.
        </p>
        <div className="landing-shots">
          <div>
            <SourcesShot />
            <div className="shot-caption">1 · Aggregate every source</div>
          </div>
          <div>
            <VmcpShot />
            <div className="shot-caption">2 · Curate into one endpoint</div>
          </div>
          <div>
            <AgentsShot />
            <div className="shot-caption">3 · Grant scoped agent keys</div>
          </div>
        </div>
      </section>

      {/* how it works */}
      <section className="landing-section">
        <h2 className="landing-h2">How it works</h2>
        <div className="landing-steps">
          {STEPS.map(([title, body], i) => (
            <div key={title} className="landing-step">
              <div className="landing-step-num">{i + 1}</div>
              <div>
                <div className="landing-step-title">{title}</div>
                <div className="muted">{body}</div>
              </div>
            </div>
          ))}
        </div>
        <p className="landing-foot muted">
          Self-hosted · single binary + Postgres ·{' '}
          <a href="https://github.com/comind-pro/comind-mcp" target="_blank" rel="noreferrer">
            open source on GitHub
          </a>
          . Create an account above to start.
        </p>
      </section>
    </div>
  );
}
