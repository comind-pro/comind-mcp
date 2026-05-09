import { useState } from 'react';
import { api, type AuthUser } from './api.js';

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
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" style={{ width: 360 }}>
        <div className="brand" style={{ marginBottom: 4 }}>
          comind-mcp
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 16 }}>
          MCP gateway · {mode === 'login' ? 'sign in' : 'sign up'}
        </div>
        <input
          style={{ width: '100%', marginBottom: 8 }}
          placeholder="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          style={{ width: '100%', marginBottom: 8 }}
          placeholder="password (8+ characters)"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {err && <div className="err-msg">{err}</div>}
        <button style={{ width: '100%', marginTop: 4 }} onClick={submit} disabled={busy || !email || password.length < 8}>
          {mode === 'login' ? 'Sign in' : 'Sign up'}
        </button>
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
  );
}
