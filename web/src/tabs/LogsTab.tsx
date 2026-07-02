import { Fragment, useEffect, useState } from 'react';
import { type Agent, api, type CallLog, type Group } from '../api.js';
import { EmptyState } from '../ui.js';

interface ToolRow {
  tool_name: string;
  calls: number;
  errors: number;
  tokens: number;
  avg_ms: number;
}
interface AgentRow {
  agent: string;
  calls: number;
  errors: number;
  tokens: number;
}
interface Metrics {
  totals: { calls: number; errors: number; tokens: number; avg_ms: number; p95_ms: number };
  byTool: ToolRow[];
  byAgent: AgentRow[];
}

const WINDOWS: Record<string, number> = { '24h': 1, '7d': 7, '30d': 30, all: 0 };
const SOURCES = [
  { value: '', label: 'all' },
  { value: 'live', label: 'live' },
  { value: 'test', label: 'test' },
  { value: 'schedule', label: 'scheduled' },
] as const;

export function LogsTab() {
  const [logs, setLogs] = useState<CallLog[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [win, setWin] = useState<keyof typeof WINDOWS>('7d');
  const [source, setSource] = useState<(typeof SOURCES)[number]['value']>('');
  const [groups, setGroups] = useState<Group[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [groupId, setGroupId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Group[]>('/groups')
      .then(setGroups)
      .catch(() => {});
    api
      .get<Agent[]>('/agents')
      .then(setAgents)
      .catch(() => {});
  }, []);

  const load = async () => {
    const days = WINDOWS[win];
    const metricsParams = new URLSearchParams();
    if (days) metricsParams.set('from', new Date(Date.now() - days * 86_400_000).toISOString());
    if (source) metricsParams.set('source', source);
    const qs = metricsParams.toString();
    setMetrics(await api.get<Metrics>(`/metrics${qs ? `?${qs}` : ''}`));

    const logParams = new URLSearchParams(metricsParams);
    if (groupId) logParams.set('groupId', groupId);
    if (agentId) logParams.set('agentId', agentId);
    logParams.set('limit', '100');
    setLogs(await api.get<CallLog[]>(`/logs?${logParams.toString()}`));
  };
  useEffect(() => void load(), [win, source, groupId, agentId]);

  const stat = (label: string, value: string | number) => (
    <div className="log-stat">
      <div className="log-stat-v">{value}</div>
      <div className="log-stat-l">{label}</div>
    </div>
  );

  return (
    <>
      <div className="intro">
        Every tool call your agents make lands here — what ran, how long it took, and whether it worked.
      </div>

      <div className="page-head">
        <div>
          {metrics && (
            <span className="sub">
              {metrics.totals.calls} calls · {metrics.totals.errors} errors
            </span>
          )}
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
              <span
                key={s.value || 'all'}
                className={source === s.value ? 'on' : ''}
                onClick={() => setSource(s.value)}
              >
                {s.label}
              </span>
            ))}
          </span>
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">All workspaces</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button className="ghost" onClick={load}>
            Refresh
          </button>
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
                <tr>
                  <th>tool</th>
                  <th>calls</th>
                  <th>errors</th>
                  <th>~tokens</th>
                  <th>avg ms</th>
                </tr>
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
                {!metrics.byTool.length && (
                  <tr>
                    <td colSpan={5} className="muted">
                      No data in window.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h2>By agent</h2>
            <table>
              <thead>
                <tr>
                  <th>agent</th>
                  <th>calls</th>
                  <th>errors</th>
                  <th>~tokens</th>
                </tr>
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
                {!metrics.byAgent.length && (
                  <tr>
                    <td colSpan={4} className="muted">
                      No data in window.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="card">
        <h2>Recent calls</h2>
        <table>
          <thead>
            <tr>
              <th>time</th>
              <th>tool</th>
              <th>source</th>
              <th>status</th>
              <th>ms</th>
              <th>~tok</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => {
              const isError = l.status !== 'success';
              const isOpen = expanded === l.id;
              return (
                <Fragment key={l.id}>
                  <tr
                    className={isError ? 'clickable' : undefined}
                    onClick={isError ? () => setExpanded(isOpen ? null : l.id) : undefined}
                  >
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
                  {isError && isOpen && (
                    <tr className="detail-row">
                      <td colSpan={6}>
                        <div className="row" style={{ gap: 16 }}>
                          <span>
                            tool: <span className="mono">{l.toolName}</span>
                          </span>
                          <span>agent: {l.agentId ?? '—'}</span>
                          <span>source: {l.source}</span>
                          <span>at: {new Date(l.ts).toISOString()}</span>
                          <span>duration: {l.durationMs}ms</span>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {!logs.length && (
              <tr>
                <td colSpan={6}>
                  <EmptyState
                    title="No activity yet"
                    body="Calls appear here as soon as an agent (or a schedule) runs a tool."
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
