import { useEffect, useMemo, useState } from 'react';
import { api, type Source, type Tool } from '../api.js';
import { buildInput, parseInput } from './SchemaBuilder.js';
import { type Cfg, type Editing, type MetaForm, type Step, ToolEditor } from './ToolEditor.js';

export function ToolsTab() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [err, setErr] = useState('');

  const [search, setSearch] = useState('');
  const [fType, setFType] = useState<'all' | 'native' | 'composite'>('all');
  const [fSource, setFSource] = useState('');
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [ed, setEd] = useState<Editing | null>(null);

  const load = () =>
    api
      .get<Tool[]>('/tools')
      .then(setTools)
      .catch((e) => setErr(String(e.message)));
  useEffect(() => {
    void load();
    void api.get<Source[]>('/sources').then(setSources);
  }, []);

  const srcName = (id: string | null) => sources.find((s) => s.id === id)?.name ?? 'Unknown source';
  const patch = (p: Partial<Editing>) => setEd((e) => (e ? { ...e, ...p } : e));
  const setMeta = (p: Partial<MetaForm>) => setEd((e) => (e?.meta ? { ...e, meta: { ...e.meta, ...p } } : e));
  const close = () => setEd(null);

  // composite registry key — derived from the display name, never typed by hand
  const slugName = (s: string) =>
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled';

  const openNewComposite = () =>
    setEd({
      id: 'new',
      kind: 'composite',
      name: slugName('New composite tool'),
      displayName: 'New composite tool',
      description: '',
      meta: {
        readOnly: '',
        dangerous: '',
        perms: '',
        daily: '',
        autoSafe: '',
        confirm: '',
        examplesRaw: '',
        examplesErr: null,
      },
      params: [],
      required: [],
      outParams: [],
      outRequired: [],
      steps: [{ id: 's1', tool: '', args: {} }],
      output: 'Result: ${$.steps.s1.text}',
      outMode: 'text',
      right: 'json',
      jsonRaw: null,
      jsonError: null,
      testVals: {},
      testOut: null,
      testing: false,
      pickerStep: null,
      pickerQuery: '',
      stepSchemaOpen: {},
      stepTest: {},
    });

  const emptyMeta = (): MetaForm => ({
    readOnly: '',
    dangerous: '',
    perms: '',
    daily: '',
    autoSafe: '',
    confirm: '',
    examplesRaw: '',
    examplesErr: null,
  });

  const openNewVirtual = () =>
    setEd({
      id: 'new',
      kind: 'virtual',
      name: slugName('New virtual tool'),
      displayName: 'New virtual tool',
      description: '',
      meta: emptyMeta(),
      executable: true,
      respRaw: '',
      respMode: 'json',
      req: { method: 'GET', url: '', headers: '', query: '', body: '' },
      params: [],
      required: [],
      outParams: [],
      outRequired: [],
      steps: [],
      output: undefined,
      outMode: 'text',
      right: 'test',
      jsonRaw: null,
      jsonError: null,
      testVals: {},
      testOut: null,
      testing: false,
      pickerStep: null,
      pickerQuery: '',
      stepSchemaOpen: {},
      stepTest: {},
    });

  const open = async (t: Tool) => {
    if (ed?.id === t.id) return close();
    setErr('');
    const { params, required } = parseInput(t.inputSchema);
    const out = parseInput(t.outputSchema);
    const triS = (v: boolean | null | undefined) => (v == null ? '' : String(v));
    const ru = t.recommendedUse ?? {};
    const base: Editing = {
      id: t.id,
      kind: t.kind,
      name: t.name,
      displayName: t.displayName ?? '',
      description: t.description ?? '',
      meta: {
        readOnly: triS(t.readOnly),
        dangerous: triS(t.dangerous),
        perms: (t.permissions ?? []).join(', '),
        daily: triS(ru.daily_report),
        autoSafe: triS(ru.safe_for_automation),
        confirm: triS(ru.requires_user_confirmation),
        examplesRaw: t.examples?.length ? JSON.stringify(t.examples, null, 2) : '',
        examplesErr: null,
      },
      params,
      required,
      outParams: t.outputSchema ? out.params : [],
      outRequired: out.required,
      steps: [],
      output: undefined,
      outMode: 'text',
      right: 'json',
      jsonRaw: null,
      jsonError: null,
      testVals: {},
      testOut: null,
      testing: false,
      pickerStep: null,
      pickerQuery: '',
      stepSchemaOpen: {},
      stepTest: {},
    };
    setEd(base);
    if (t.kind === 'virtual') {
      const full = await api.get<{ request?: Cfg; executable?: boolean; response?: unknown }>(`/virtual-tools/${t.id}`);
      const rq = full.request ?? {};
      setEd((e) =>
        e && e.id === t.id
          ? {
              ...e,
              executable: full.executable ?? true,
              respMode: typeof full.response === 'string' ? 'text' : 'json',
              respRaw:
                full.response == null
                  ? ''
                  : typeof full.response === 'string'
                    ? full.response
                    : JSON.stringify(full.response, null, 2),
              req: {
                method: (rq.method as string) ?? 'GET',
                url: (rq.url as string) ?? '',
                headers: rq.headers ? JSON.stringify(rq.headers, null, 2) : '',
                query: rq.query ? JSON.stringify(rq.query, null, 2) : '',
                body: rq.body !== undefined ? JSON.stringify(rq.body, null, 2) : '',
              },
            }
          : e,
      );
    }
    if (t.kind === 'composite') {
      const full = await api.get<Tool & { definition: Cfg }>(`/composite-tools/${t.id}`);
      const { inputSchema, outputSchema, output, steps, ...rest } = full.definition ?? {};
      const norm: Step[] = (steps ?? []).map((s: Cfg, i: number) => ({
        id: s.id ?? `s${i + 1}`,
        tool: s.tool ?? '',
        args: s.args ?? {},
        when: s.when,
      }));
      void rest;
      const inp = parseInput(inputSchema);
      const o = parseInput(outputSchema);
      setEd((e) =>
        e && e.id === t.id
          ? {
              ...e,
              params: inp.params,
              required: inp.required,
              outParams: outputSchema ? o.params : [],
              outRequired: o.required,
              steps: norm,
              output,
              outMode: output != null && typeof output === 'object' ? 'json' : 'text',
            }
          : e,
      );
    }
  };

  // ----- saving -----
  const saveNative = async (e: Editing) => {
    setErr('');
    const body: Cfg = { displayName: e.displayName || null, description: e.description || null };
    const orig = tools.find((t) => t.id === e.id);
    if (e.name && e.name !== orig?.name) body.name = e.name;
    body.inputSchema = buildInput(e.params, e.required);
    body.outputSchema = e.outParams.length ? buildInput(e.outParams, e.outRequired) : null;
    const mb = metaBody(e);
    if (mb === 'error') return;
    Object.assign(body, mb);
    try {
      await api.patch(`/tools/${e.id}`, body);
      await load();
      close();
    } catch (err) {
      setErr(String((err as Error).message));
    }
  };

  // Build the discovery-metadata patch body from the editor's `meta` form.
  // Returns 'error' (and flags the examples field) when the examples JSON is invalid.
  const metaBody = (e: Editing): Cfg | 'error' => {
    const m = e.meta;
    if (!m) return {};
    const tri = (v: string) => (v === '' ? null : v === 'true');
    const ru: Record<string, boolean> = {};
    if (m.daily !== '') ru.daily_report = m.daily === 'true';
    if (m.autoSafe !== '') ru.safe_for_automation = m.autoSafe === 'true';
    if (m.confirm !== '') ru.requires_user_confirmation = m.confirm === 'true';
    const body: Cfg = {
      readOnly: tri(m.readOnly),
      dangerous: tri(m.dangerous),
      permissions: m.perms
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      recommendedUse: Object.keys(ru).length ? ru : null,
    };
    if (m.examplesRaw.trim()) {
      try {
        const ex = JSON.parse(m.examplesRaw);
        if (!Array.isArray(ex)) throw new Error('examples must be a JSON array');
        body.examples = ex;
      } catch (er) {
        setMeta({ examplesErr: String((er as Error).message) });
        return 'error';
      }
    } else body.examples = [];
    return body;
  };

  const saveComposite = async (e: Editing) => {
    setErr('');
    try {
      const definition: Cfg = {
        steps: e.steps.map((s) => ({ id: s.id, tool: s.tool, args: s.args, ...(s.when ? { when: s.when } : {}) })),
      };
      if (e.params.length) definition.inputSchema = buildInput(e.params, e.required);
      if (e.outParams.length) definition.outputSchema = buildInput(e.outParams, e.outRequired);
      if (e.output !== undefined) definition.output = e.output;
      const mb = metaBody(e);
      if (mb === 'error') return;
      if (e.id === 'new') {
        const created = await api.post<{ id: string }>('/composite-tools', {
          name: e.name,
          definition,
          displayName: e.displayName || undefined,
          description: e.description || undefined,
        });
        if (Object.keys(mb).length) await api.patch(`/tools/${created.id}`, mb);
        await load();
        close();
        return;
      }
      const idBody: Cfg = { displayName: e.displayName || null, description: e.description || null, ...mb };
      const orig = tools.find((t) => t.id === e.id);
      if (e.name && e.name !== orig?.name) idBody.name = e.name;
      await api.patch(`/tools/${e.id}`, idBody);
      await api.patch(`/composite-tools/${e.id}`, { definition });
      await load();
      close();
    } catch (err) {
      setErr(`Invalid JSON: ${(err as Error).message}`);
    }
  };

  const saveVirtual = async (e: Editing) => {
    setErr('');
    const r = e.req!;
    const executable = e.executable !== false;
    let request: Cfg | undefined;
    if (executable) {
      if (!r.url.trim()) return setErr('URL is required for an executable tool');
      try {
        request = {
          method: r.method,
          url: r.url,
          ...(r.headers.trim() ? { headers: JSON.parse(r.headers) } : {}),
          ...(r.query.trim() ? { query: JSON.parse(r.query) } : {}),
          ...(r.body.trim() ? { body: JSON.parse(r.body) } : {}),
        };
      } catch (err) {
        setErr(`Request headers/query/body must be valid JSON: ${(err as Error).message}`);
        return;
      }
    }
    // descriptive: optional static response body (JSON or plain text)
    let response: unknown | undefined;
    if (!executable) {
      const raw = (e.respRaw ?? '').trim();
      if (!raw) response = null;
      else if (e.respMode === 'text') response = e.respRaw;
      else {
        try {
          response = JSON.parse(e.respRaw!);
        } catch (err) {
          setErr(`Response body must be valid JSON (or switch to Text): ${(err as Error).message}`);
          return;
        }
      }
    }
    const inputSchema = buildInput(e.params, e.required);
    const outputSchema = e.outParams.length ? buildInput(e.outParams, e.outRequired) : null;
    const mb = metaBody(e);
    if (mb === 'error') return;
    try {
      if (e.id === 'new') {
        const created = await api.post<{ id: string }>('/virtual-tools', {
          name: e.name,
          displayName: e.displayName || undefined,
          description: e.description || undefined,
          inputSchema,
          outputSchema,
          executable,
          ...(request ? { request } : {}),
          ...(response !== undefined ? { response } : {}),
        });
        if (Object.keys(mb).length) await api.patch(`/tools/${created.id}`, mb);
        await load();
        close();
        return;
      }
      await api.patch(`/virtual-tools/${e.id}`, {
        executable,
        ...(request ? { request } : {}),
        ...(response !== undefined ? { response } : {}),
      });
      const idBody: Cfg = {
        displayName: e.displayName || null,
        description: e.description || null,
        inputSchema,
        outputSchema,
        ...mb,
      };
      const orig = tools.find((t) => t.id === e.id);
      if (e.name && e.name !== orig?.name) idBody.name = e.name;
      await api.patch(`/tools/${e.id}`, idBody);
      await load();
      close();
    } catch (err) {
      setErr(String((err as Error).message));
    }
  };

  const del = async (id: string) => {
    if (!confirm('Delete this tool?')) return;
    await api.del(`/tools/${id}`).catch((e) => setErr(String(e.message)));
    if (ed?.id === id) close();
    await load();
  };

  const toggleVisible = async (t: Tool) => {
    setTools((ts) => ts.map((x) => (x.id === t.id ? { ...x, visible: !x.visible } : x)));
    await api.patch(`/tools/${t.id}`, { visible: !t.visible }).catch((e) => setErr(String(e.message)));
  };

  // ----- filtering / grouping -----
  const filtered = tools.filter(
    (t) =>
      (!search ||
        t.name.toLowerCase().includes(search.toLowerCase()) ||
        (t.displayName ?? '').toLowerCase().includes(search.toLowerCase())) &&
      (fType === 'all' || t.kind === fType) &&
      (!fSource || t.sourceId === fSource),
  );

  const groups = useMemo(() => {
    const m = new Map<string, { key: string; label: string; composite: boolean; tools: Tool[] }>();
    for (const t of filtered) {
      const key =
        t.kind === 'composite' ? '__composite' : t.kind === 'virtual' ? '__virtual' : (t.sourceId ?? '__none');
      if (!m.has(key)) {
        m.set(key, {
          key,
          label:
            t.kind === 'composite' ? 'Composite tools' : t.kind === 'virtual' ? 'Virtual tools' : srcName(t.sourceId),
          composite: t.kind === 'composite' || t.kind === 'virtual',
          tools: [],
        });
      }
      m.get(key)!.tools.push(t);
    }
    return [...m.values()].sort((a, b) => Number(a.composite) - Number(b.composite) || a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sources]);

  const toggleGroup = (k: string) => {
    const next = new Set(opened);
    next.has(k) ? next.delete(k) : next.add(k);
    setOpened(next);
  };

  const visibleTotal = tools.filter((t) => t.visible).length;

  const onSave = () =>
    ed
      ? ed.kind === 'composite'
        ? saveComposite(ed)
        : ed.kind === 'virtual'
          ? saveVirtual(ed)
          : saveNative(ed)
      : Promise.resolve();
  const onDelete = () => (ed ? del(ed.id) : Promise.resolve());

  const editor = (e: Editing) => (
    <ToolEditor
      ed={e}
      tools={tools}
      sources={sources}
      patch={patch}
      setMeta={setMeta}
      setEd={setEd}
      err={err}
      setErr={setErr}
      onSave={onSave}
      onDelete={onDelete}
      onClose={close}
    />
  );

  return (
    <>
      <div className="intro">
        <b>Tools</b> — everything from your sources. <b>native</b> = one direct call (appear after Import).{' '}
        <b>composite</b> = one tool that internally makes several calls. Click a row to edit, toggle the switch to
        show/hide from agents.
      </div>

      <div className="page-head">
        <div>
          <span className="sub">
            {tools.length} tools · {visibleTotal} visible to agents
          </span>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn-primary" onClick={openNewVirtual}>
            + New virtual tool
          </button>
          <button className="btn-primary" onClick={openNewComposite}>
            + New composite tool
          </button>
        </div>
      </div>

      {/* draft composite */}
      {ed?.id === 'new' && (
        <div className="scard open" style={{ marginBottom: 18 }}>
          <div className="scard-head">
            <span className="mono" style={{ fontSize: 13.5, fontWeight: 600, color: '#b48cf0' }}>
              {ed.name || 'new_tool'}
            </span>
            <span className="tbadge composite">{ed.kind} · draft</span>
            <span className="edit-link" style={{ marginLeft: 'auto' }} onClick={close}>
              Close
            </span>
            <span className="chev up">⌄</span>
          </div>
          <div className="scard-body">{editor(ed)}</div>
        </div>
      )}

      {/* toolbar */}
      <div className="chip-row">
        <span className="chip-search">
          <span
            style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }}
          >
            ⌕
          </span>
          <input
            style={{ width: '100%', paddingLeft: 28 }}
            placeholder="Search by name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </span>
        <span className="seg">
          {(['all', 'native', 'composite'] as const).map((v) => (
            <span key={v} className={fType === v ? 'on' : ''} onClick={() => setFType(v)}>
              {v === 'all' ? 'All' : v === 'native' ? 'Native' : 'Composite'}
            </span>
          ))}
        </span>
        <select value={fSource} onChange={(e) => setFSource(e.target.value)}>
          <option value="">All sources</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {err && !ed && <div className="err-msg">{err}</div>}

      {!groups.length && (
        <div className="muted" style={{ textAlign: 'center', padding: '50px 20px' }}>
          Nothing found. Import tools from a source (Sources tab).
        </div>
      )}

      {groups.map((g) => {
        const isOpen = opened.has(g.key) || search.length > 0 || (ed != null && g.tools.some((t) => t.id === ed.id));
        return (
          <div key={g.key} style={{ marginBottom: 18 }}>
            <div className="tgroup-head" onClick={() => toggleGroup(g.key)}>
              <span className={`gchev ${isOpen ? '' : 'closed'}`}>⌄</span>
              <span className="gtitle">{g.label}</span>
              <span className={`tbadge ${g.composite ? 'composite' : ''}`}>{g.composite ? 'composite' : 'source'}</span>
              <span className="gcount">{g.tools.length} tools</span>
            </div>
            {isOpen &&
              g.tools.map((t) => {
                const rowOpen = ed?.id === t.id;
                const comp = t.kind === 'composite';
                return (
                  <div key={t.id} className={`scard ${rowOpen ? 'open' : ''}`}>
                    <div className="scard-head" onClick={() => open(t)}>
                      <span
                        className={`switch ${t.visible ? 'on' : ''}`}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          toggleVisible(t);
                        }}
                      >
                        <span className="knob" />
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 11, flex: 1, minWidth: 0 }}>
                        <span
                          className="mono"
                          style={{ fontSize: 13.5, fontWeight: 600, color: comp ? '#b48cf0' : 'var(--accent)' }}
                        >
                          {t.name}
                        </span>
                        <span
                          className="muted"
                          style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        >
                          {t.displayName ?? ''}
                        </span>
                      </span>
                      <span className={`tbadge tool-badge ${comp ? 'composite' : ''}`}>
                        {comp ? 'composite' : 'native'}
                      </span>
                      <span className="edit-link">{rowOpen ? 'Close' : 'Edit'}</span>
                      <span className={`chev ${rowOpen ? 'up' : ''}`}>⌄</span>
                    </div>
                    {rowOpen && ed && <div className="scard-body">{editor(ed)}</div>}
                  </div>
                );
              })}
          </div>
        );
      })}
    </>
  );
}
