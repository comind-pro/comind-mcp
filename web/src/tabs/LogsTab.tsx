import { useEffect, useState } from 'react';
import { api, type CallLog } from '../api.js';

interface Metrics {
  totals: { calls: number; errors: number; tokens: number };
  byTool: Record<string, { calls: number; errors: number; tokens: number }>;
}

export function LogsTab() {
  const [logs, setLogs] = useState<CallLog[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  const load = async () => {
    setLogs(await api.get<CallLog[]>('/logs?limit=100'));
    setMetrics(await api.get<Metrics>('/metrics'));
  };
  useEffect(() => void load(), []);

  return (
    <>
      <div className="intro">
        <b>Logs (observability)</b> — every tool call through the gateway is recorded here: which tool, success/error,
        duration, token estimate. <b>Metrics</b> aggregates by tool, <b>Recent calls</b> shows the latest calls.
        Useful for seeing what the agents actually do and where the errors are.
      </div>
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Metrics</h2>
          <button className="ghost" style={{ marginLeft: 'auto' }} onClick={load}>
            Refresh
          </button>
        </div>
        {metrics && (
          <>
            <div className="row" style={{ marginTop: 12 }}>
              <span className="pill">calls: {metrics.totals.calls}</span>
              <span className="pill">errors: {metrics.totals.errors}</span>
              <span className="pill">~tokens: {metrics.totals.tokens}</span>
            </div>
            <div className="spacer" />
            <table>
              <thead>
                <tr>
                  <th>tool</th>
                  <th>calls</th>
                  <th>errors</th>
                  <th>~tokens</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(metrics.byTool).map(([tool, m]) => (
                  <tr key={tool}>
                    <td className="mono">{tool}</td>
                    <td>{m.calls}</td>
                    <td>{m.errors}</td>
                    <td>{m.tokens}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      <div className="card">
        <h2>Recent calls</h2>
        <table>
          <thead>
            <tr>
              <th>time</th>
              <th>tool</th>
              <th>status</th>
              <th>ms</th>
              <th>~tok</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td className="muted">{new Date(l.ts).toLocaleTimeString()}</td>
                <td className="mono">{l.toolName}</td>
                <td>
                  <span className={`badge ${l.status === 'success' ? 'ok' : 'err'}`}>{l.status}</span>
                </td>
                <td>{l.durationMs}</td>
                <td>{l.tokensEst ?? '—'}</td>
              </tr>
            ))}
            {!logs.length && (
              <tr>
                <td colSpan={5} className="muted">
                  No calls logged yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
