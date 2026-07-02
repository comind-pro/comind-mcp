import { useEffect, useState } from 'react';
import type { PageId } from './App.js';
import { type Agent, api, type CallLog, type Group, type Source, type Tool } from './api.js';

interface Totals {
  calls: number;
  errors: number;
}

interface StepDef {
  label: string;
  body: string;
  page: PageId;
  done: boolean;
}

export function deriveSteps(counts: { sources: number; tools: number; groups: number; agents: number }): StepDef[] {
  return [
    {
      label: 'Connect a source',
      body: 'Link an MCP server, REST API, database, or email account.',
      page: 'connections',
      done: counts.sources > 0,
    },
    {
      label: 'Import tools',
      body: 'Pull in the actions your connection offers and curate them.',
      page: 'tools',
      done: counts.tools > 0,
    },
    {
      label: 'Create a workspace',
      body: 'Bundle chosen tools into one endpoint for your agent.',
      page: 'workspaces',
      done: counts.groups > 0,
    },
    {
      label: 'Add an agent & get its key',
      body: 'Create an agent, grant it the workspace, copy its key.',
      page: 'agents',
      done: counts.agents > 0,
    },
  ];
}

export function Home({ onNavigate }: { onNavigate: (p: PageId) => void }) {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [recent, setRecent] = useState<CallLog[]>([]);
  const [err, setErr] = useState(false);

  const load = () => {
    setErr(false);
    void api
      .get<Source[]>('/sources')
      .then(setSources)
      .catch(() => setErr(true));
    void api
      .get<Tool[]>('/tools')
      .then(setTools)
      .catch(() => setErr(true));
    void api
      .get<Group[]>('/groups')
      .then(setGroups)
      .catch(() => setErr(true));
    void api
      .get<Agent[]>('/agents')
      .then(setAgents)
      .catch(() => setErr(true));
    const from = new Date(Date.now() - 86_400_000).toISOString();
    void api
      .get<{ totals: Totals }>(`/metrics?from=${encodeURIComponent(from)}`)
      .then((m) => setTotals(m.totals))
      .catch(() => {});
    void api
      .get<CallLog[]>('/logs?limit=5')
      .then(setRecent)
      .catch(() => {});
  };

  useEffect(load, []);

  if (err && (!sources || !tools || !groups || !agents)) {
    return (
      <div className="home-hero">
        <p className="err-msg">Couldn't load your workspace.</p>
        <button className="btn-primary" onClick={load}>
          Retry
        </button>
      </div>
    );
  }

  if (!sources || !tools || !groups || !agents) return <div className="text-muted">Loading…</div>;

  const steps: StepDef[] = deriveSteps({
    sources: sources.length,
    tools: tools.length,
    groups: groups.length,
    agents: agents.length,
  });
  const allDone = steps.every((s) => s.done);
  const firstOpen = steps.findIndex((s) => !s.done);

  if (!sources.length) {
    return (
      <div className="home-hero">
        <h2>Connect your first source</h2>
        <p className="text-muted">
          A source is anything your agents should be able to use — an MCP server, a REST API, a database, or an email
          account. Everything else builds on it.
        </p>
        <button className="btn-primary" onClick={() => onNavigate('connections')}>
          Connect a source
        </button>
      </div>
    );
  }

  return (
    <>
      {!allDone && (
        <div className="home-steps">
          {steps.map((s, i) => (
            <button
              key={s.page}
              className={`home-step ${s.done ? 'done' : ''} ${i === firstOpen ? 'next' : ''}`}
              onClick={() => onNavigate(s.page)}
            >
              <span className="home-step-mark">{s.done ? '✓' : i + 1}</span>
              <span>
                <span className="home-step-label">{s.label}</span>
                <span className="home-step-body">{s.body}</span>
              </span>
              {i === firstOpen && <span className="home-step-cta">Do this →</span>}
            </button>
          ))}
        </div>
      )}

      <div className="home-stats">
        <StatCard value={sources.length} label="connections" onClick={() => onNavigate('connections')} />
        <StatCard value={tools.length} label="tools" onClick={() => onNavigate('tools')} />
        <StatCard value={groups.length} label="workspaces" onClick={() => onNavigate('workspaces')} />
        <StatCard
          value={totals ? `${totals.calls}` : '…'}
          label={`calls · 24h${totals?.errors ? ` (${totals.errors} errors)` : ''}`}
          onClick={() => onNavigate('activity')}
        />
      </div>

      {recent.length > 0 && (
        <div className="card">
          <h2>Recent calls</h2>
          <table>
            <tbody>
              {recent.map((l) => (
                <tr key={l.id}>
                  <td className="text-muted">{new Date(l.ts).toLocaleString()}</td>
                  <td className="mono">{l.toolName}</td>
                  <td>
                    <span className={`badge ${l.status === 'success' ? 'ok' : 'err'}`}>{l.status}</span>
                  </td>
                  <td>{l.durationMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="ghost" onClick={() => onNavigate('activity')}>
            View all activity →
          </button>
        </div>
      )}
    </>
  );
}

function StatCard({ value, label, onClick }: { value: number | string; label: string; onClick: () => void }) {
  return (
    <button className="stat-card" onClick={onClick}>
      <span className="stat-card-v">{value}</span>
      <span className="stat-card-l">{label}</span>
    </button>
  );
}
