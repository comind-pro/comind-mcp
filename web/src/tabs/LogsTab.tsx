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

  return (
    <>
      <div className="intro">
        <b>Logs (observability)</b> — every tool call is recorded: tool, status, duration, token estimate, and{' '}
        <b>source</b> (<code>live</code> = agent via gateway, <code>test</code> = control-plane try-run,{' '}
        <code>schedule</code> = scheduler). Filter by time window and source; metrics aggregate in SQL.
      </div>

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Metrics</h2>
          <select value={win} onChange={(e) => setWin(e.target.value as keyof typeof WINDOWS)} style={{ marginLeft: 'auto' }}>
            {Object.keys(WINDOWS).map((w) => (
              <option key={w} value={w}>{w === 'all' ? 'all time' : `last ${w}`}</option>
            ))}
          </select>
          <select value={source} onChange={(e) => setSource(e.target.value as (typeof SOURCES)[number])}>
            <option value="">all sources</option>
            <option value="live">live</option>
            <option value="test">test</option>
            <option value="schedule">schedule</option>
          </select>
          <button className="ghost" onClick={load}>Refresh</button>
        </div>

        {metrics && (
          <>
            <div className="row" style={{ marginTop: 12 }}>
              <span className="pill">calls: {metrics.totals.calls}</span>
              <span className="pill">errors: {metrics.totals.errors}</span>
              <span className="pill">~tokens: {metrics.totals.tokens}</span>
              <span className="pill">avg: {metrics.totals.avg_ms}ms</span>
              <span className="pill">p95: {metrics.totals.p95_ms}ms</span>
            </div>

            <div className="spacer" />
            <h3>By tool</h3>
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

            <div className="spacer" />
            <h3>By agent</h3>
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
          </>
        )}
      </div>

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
                <td>
                  <span className={`badge ${l.source === 'live' ? 'ok' : 'muted'}`}>{l.source}</span>
                </td>
                <td>
                  <span className={`badge ${l.status === 'success' ? 'ok' : 'err'}`}>{l.status}</span>
                </td>
                <td>{l.durationMs}</td>
                <td>{l.tokensEst ?? '—'}</td>
              </tr>
            ))}
            {!logs.length && (
              <tr><td colSpan={6} className="muted">No calls logged yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
