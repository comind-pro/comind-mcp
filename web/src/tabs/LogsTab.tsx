import { useEffect, useState } from 'react';
import { api, type CallLog } from '../api.js';

interface ToolRow { tool_name: string; calls: number; errors: number; tokens: number; avg_ms: number }
interface AgentRow { agent: string; calls: number; errors: number; tokens: number }
interface Metrics {
  totals: { calls: number; errors: number; tokens: number; avg_ms: number; p95_ms: number };
  byTool: ToolRow[];
  byAgent: AgentRow[];
}

const WINDOWS: Record<string, number> = { '24h': 1, '7d': 7, '30d': 30, all: 0 };
const SOURCES = ['', 'live', 'test', 'schedule'] as const;

export function LogsTab() {
  const [logs, setLogs] = useState<CallLog[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [win, setWin] = useState<keyof typeof WINDOWS>('7d');
  const [source, setSource] = useState<(typeof SOURCES)[number]>('');

  const load = async () => {
    const days = WINDOWS[win];
    const params = new URLSearchParams();
    if (days) params.set('from', new Date(Date.now() - days * 86_400_000).toISOString());
    if (source) params.set('source', source);
    const qs = params.toString();
    setMetrics(await api.get<Metrics>(`/metrics${qs ? `?${qs}` : ''}`));
    params.set('limit', '100');
    setLogs(await api.get<CallLog[]>(`/logs?${params.toString()}`));
  };
  useEffect(() => void load(), [win, source]);

  const stat = (label: string, value: string | number) => (
    <div className="log-stat">
      <div className="log-stat-v">{value}</div>
      <div className="log-stat-l">{label}</div>
    </div>
  );

  return (
    <>
      <div className="intro">
        <b>Logs (observability)</b> — every tool call is recorded: tool, status, duration, token estimate, and source
        (<code>live</code> = agent via gateway, <code>test</code> = control-plane try-run, <code>schedule</code> =
        scheduler). Filter by time window and source; metrics aggregate in SQL.
      </div>

      <div className="page-head">
        <div>
          <span className="title">Logs</span>
          {metrics && <span className="sub">{metrics.totals.calls} calls · {metrics.totals.errors} errors</span>}
        </div>
        <div className="row">
          <span className="seg">
            {Object.keys(WINDOWS).map((w) => (
              <span key={w} className={win === w ? 'on' : ''} onClick={() => setWin(w as keyof typeof WINDOWS)}>
                {w === 'all' ? 'all' : w}
              </span>
            ))}
          </span>
          <span className="seg">
            {SOURCES.map((s) => (
              <span key={s || 'all'} className={source === s ? 'on' : ''} onClick={() => setSource(s)}>
                {s || 'all'}
              </span>
            ))}
          </span>
          <button className="ghost" onClick={load}>Refresh</button>
        </div>
      </div>

      {metrics && (
        <>
          <div className="log-stats">
            {stat('calls', metrics.totals.calls)}
            {stat('errors', metrics.totals.errors)}
            {stat('~tokens', metrics.totals.tokens)}
            {stat('avg ms', metrics.totals.avg_ms)}
            {stat('p95 ms', metrics.totals.p95_ms)}
          </div>

          <div className="card">
            <h2>By tool</h2>
            <table>
              <thead>
                <tr><th>tool</th><th>calls</th><th>errors</th><th>~tokens</th><th>avg ms</th></tr>
              </thead>
              <tbody>
                {metrics.byTool.map((m) => (
                  <tr key={m.tool_name}>
                    <td className="mono">{m.tool_name}</td>
                    <td>{m.calls}</td>
                    <td>{m.errors}</td>
                    <td>{m.tokens}</td>
                    <td>{m.avg_ms}</td>
                  </tr>
                ))}
                {!metrics.byTool.length && <tr><td colSpan={5} className="muted">No data in window.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h2>By agent</h2>
            <table>
              <thead>
                <tr><th>agent</th><th>calls</th><th>errors</th><th>~tokens</th></tr>
              </thead>
              <tbody>
                {metrics.byAgent.map((m) => (
                  <tr key={m.agent}>
                    <td className="mono">{m.agent}</td>
                    <td>{m.calls}</td>
                    <td>{m.errors}</td>
                    <td>{m.tokens}</td>
                  </tr>
                ))}
                {!metrics.byAgent.length && <tr><td colSpan={4} className="muted">No data in window.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="card">
        <h2>Recent calls</h2>
        <table>
          <thead>
            <tr><th>time</th><th>tool</th><th>source</th><th>status</th><th>ms</th><th>~tok</th></tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td className="muted">{new Date(l.ts).toLocaleString()}</td>
                <td className="mono">{l.toolName}</td>
                <td><span className={`badge ${l.source === 'live' ? 'ok' : 'muted'}`}>{l.source}</span></td>
                <td><span className={`badge ${l.status === 'success' ? 'ok' : 'err'}`}>{l.status}</span></td>
                <td>{l.durationMs}</td>
                <td>{l.tokensEst ?? '—'}</td>
              </tr>
            ))}
            {!logs.length && <tr><td colSpan={6} className="muted">No calls logged yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
