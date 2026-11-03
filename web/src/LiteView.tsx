import { useEffect, useState } from 'react';
import { type Agent, api, type Source, type Tool } from './api.js';
import { humanStatus } from './tabs/SourcesTab.js';
import { CopyRow, Loading } from './ui.js';

type Service = { id: string; name: string; source: Source | null; tools: Tool[] };

/** Group visible tools by the connection they come from; tools built here (composite, virtual, python) last. */
export function servicesOf(sources: Source[], tools: Tool[]): Service[] {
  const visible = tools.filter((t) => t.visible);
  const list: Service[] = sources
    .map((s) => ({ id: s.id, name: s.name, source: s, tools: visible.filter((t) => t.sourceId === s.id) }))
    .filter((s) => s.tools.length);
  const own = visible.filter((t) => !t.sourceId);
  if (own.length) list.push({ id: 'own', name: 'Your own tools', source: null, tools: own });
  return list;
}

const changesData = (t: Tool) => t.dangerous === true || t.readOnly === false;

/** Lite mode: pick an agent, switch whole services (or single tools) on and off. */
export function LiteView({ onFull }: { onFull: (hash: string) => void }) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [allowed, setAllowed] = useState<Set<string> | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([api.get<Agent[]>('/agents'), api.get<Source[]>('/sources'), api.get<Tool[]>('/tools')])
      .then(([a, s, t]) => {
        setAgents(a);
        setServices(servicesOf(s, t));
        setAgentId((cur) => cur ?? a[0]?.id ?? null);
      })
      .catch((e) => setErr(String(e.message)));
  }, []);

  useEffect(() => {
    if (!agentId) return;
    setAllowed(null);
    setOpen(null);
    void api
      .get<{ toolIds: string[] }>(`/agents/${agentId}/tools`)
      .then((r) => setAllowed(new Set(r.toolIds)))
      .catch((e) => setErr(String(e.message)));
  }, [agentId]);

  const save = async (next: Set<string>) => {
    const prev = allowed;
    setAllowed(next);
    setErr(null);
    try {
      await api.put(`/agents/${agentId}/tools`, { toolIds: [...next] });
    } catch (e) {
      setAllowed(prev);
      setErr(`Not saved: ${(e as Error).message}`);
    }
  };
  const toggle = (ids: string[], on: boolean) => {
    if (!allowed) return;
    const next = new Set(allowed);
    for (const id of ids) on ? next.add(id) : next.delete(id);
    void save(next);
  };

  if (!agents) return err ? <div className="err-msg">{err}</div> : <Loading />;
  const agent = agents.find((a) => a.id === agentId);
  const onCount = allowed ? services.filter((s) => s.tools.some((t) => allowed.has(t.id))).length : 0;

  return (
    <div className="lite">
      <nav className="lite-agents" aria-label="Agents">
        <div className="lite-label">Agents</div>
        {agents.map((a) => (
          <button
            key={a.id}
            className={`lite-agent${a.id === agentId ? ' on' : ''}`}
            aria-current={a.id === agentId ? 'true' : undefined}
            onClick={() => setAgentId(a.id)}
          >
            <span className="lite-av">{a.name[0]?.toUpperCase()}</span>
            {a.name}
          </button>
        ))}
        <button className="lite-link" onClick={() => onFull('/agents/new')}>
          + New agent
        </button>
      </nav>

      <section className="lite-main">
        {!agent ? (
          <p className="text-muted">No agents yet. Create one to give it access to your services.</p>
        ) : (
          <>
            <h2 className="lite-title">{agent.name}</h2>
            <p className="lite-lead">
              {allowed
                ? `Uses ${onCount} of ${services.length} services. Switch a service on and ${agent.name} can use it right away.`
                : 'Loading…'}
            </p>
            {err && <div className="err-msg">{err}</div>}

            <div className="lite-list">
              {services.map((s) => {
                const on = allowed ? s.tools.filter((t) => allowed.has(t.id)) : [];
                const all = on.length === s.tools.length;
                const broken = s.source && s.source.status === 'error';
                const blocked = s.tools.filter((t) => !allowed?.has(t.id)).map((t) => t.displayName ?? t.name);
                return (
                  <div key={s.id} className={`lite-svc${on.length ? ' on' : ''}`}>
                    <div className="lite-row">
                      <span className="lite-ic">{s.name.slice(0, 2)}</span>
                      <span className="grow">
                        <span className="lite-name">{s.name}</span>
                        <span className={`lite-sub${broken ? ' err' : ''}`}>
                          {broken
                            ? humanStatus(s.source?.statusMessage ?? 'connection failed')
                            : !on.length
                              ? `${s.tools.length} tools`
                              : all
                                ? `all ${s.tools.length} tools`
                                : `${on.length} of ${s.tools.length} tools · off: ${blocked.slice(0, 3).join(', ')}${blocked.length > 3 ? ` +${blocked.length - 3}` : ''}`}
                        </span>
                      </span>
                      {broken && s.source && (
                        <button className="ghost mini" onClick={() => onFull(`/connections/${s.source?.id}`)}>
                          Fix
                        </button>
                      )}
                      <button
                        className="ghost mini"
                        aria-expanded={open === s.id}
                        onClick={() => setOpen(open === s.id ? null : s.id)}
                      >
                        Choose tools
                      </button>
                      <label className="lite-sw">
                        <input
                          type="checkbox"
                          checked={on.length > 0}
                          disabled={!allowed}
                          aria-label={`${agent.name} can use ${s.name}`}
                          onChange={(e) =>
                            toggle(
                              s.tools.map((t) => t.id),
                              e.target.checked,
                            )
                          }
                        />
                        <i />
                      </label>
                    </div>
                    {open === s.id && (
                      <div className="lite-tools">
                        {s.tools.map((t) => (
                          <label key={t.id} className="lite-tool">
                            <span className="lite-sw sm">
                              <input
                                type="checkbox"
                                checked={!!allowed?.has(t.id)}
                                disabled={!allowed}
                                onChange={(e) => toggle([t.id], e.target.checked)}
                              />
                              <i />
                            </span>
                            <code>{t.displayName ?? t.name}</code>
                            {changesData(t) && <span className="lite-warn">changes data</span>}
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="lite-connect">
              <CopyRow label="Connect this agent (Claude, Cursor, any MCP client)" text={`${api.base}/a/mcp`} />
              <button className="lite-link" onClick={() => onFull(`/agents/${agent.id}`)}>
                Keys and connection details
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
