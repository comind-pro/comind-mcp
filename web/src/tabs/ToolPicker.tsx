import { useMemo, useState } from 'react';
import type { Source, Tool } from '../api.js';

interface Group {
  key: string;
  label: string;
  tools: Tool[];
}

/** Grouped, collapsible, searchable tool checkbox picker.
 *  Groups native tools by source; composites in their own group. */
export function ToolPicker({
  tools,
  sources,
  selected,
  onChange,
}: {
  tools: Tool[];
  sources: Source[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());

  const groups = useMemo<Group[]>(() => {
    const srcName = (id: string | null) => sources.find((s) => s.id === id)?.name ?? 'Unknown source';
    const byKey = new Map<string, Group>();
    for (const t of tools) {
      const key = t.kind === 'composite' ? '__composite' : (t.sourceId ?? '__none');
      const label = t.kind === 'composite' ? 'Composite tools' : srcName(t.sourceId);
      if (!byKey.has(key)) byKey.set(key, { key, label, tools: [] });
      byKey.get(key)!.tools.push(t);
    }
    return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [tools, sources]);

  const q = search.toLowerCase();
  const matches = (t: Tool) => !q || t.name.toLowerCase().includes(q);

  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    onChange(next);
  };

  const bulk = (groupTools: Tool[], add: boolean) => {
    const next = new Set(selected);
    for (const t of groupTools) add ? next.add(t.id) : next.delete(t.id);
    onChange(next);
  };

  const toggleOpen = (key: string) => {
    const next = new Set(open);
    next.has(key) ? next.delete(key) : next.add(key);
    setOpen(next);
  };

  return (
    <div>
      <input
        className="grow"
        style={{ width: '100%', marginBottom: 10 }}
        placeholder="🔍 search tools…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {groups.map((g) => {
        const visible = g.tools.filter(matches);
        if (q && visible.length === 0) return null;
        const selCount = g.tools.filter((t) => selected.has(t.id)).length;
        const expanded = open.has(g.key) || q.length > 0;
        return (
          <div key={g.key} className="picker-group">
            <div className="picker-head">
              <span className="picker-toggle" onClick={() => toggleOpen(g.key)}>
                {expanded ? '▾' : '▸'} <b>{g.label}</b>{' '}
                <span className="muted">
                  ({selCount}/{g.tools.length})
                </span>
              </span>
              <span className="row gap-4">
                <button className="ghost mini" onClick={() => bulk(visible, true)}>
                  all
                </button>
                <button className="ghost mini" onClick={() => bulk(visible, false)}>
                  none
                </button>
              </span>
            </div>
            {expanded && (
              <div className="picker-body">
                {visible.map((t) => (
                  <label key={t.id} className="picker-item">
                    <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
                    <span className="mono">{t.name}</span>
                    <span className="pill">{t.kind}</span>
                    {!t.visible && <span className="badge muted">hidden</span>}
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {!groups.length && <span className="muted">No tools. Import from a source.</span>}
    </div>
  );
}
