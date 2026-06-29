import { useEffect, useMemo, useState } from 'react';
import { api, type Source, type Tool } from '../api.js';
import { OutputField } from './CompositeBuilder.js';
import { buildInput, FieldRows, parseInput, ValueInput, type Field } from './SchemaBuilder.js';

interface StepTrace { id: string; tool: string; text: string; isError: boolean; skipped?: boolean }
interface RunResult { content: { text?: string }[]; isError?: boolean; steps?: StepTrace[] }
type Cfg = Record<string, any>;
interface Step { id: string; tool: string; args: Record<string, string>; when?: string }

interface MetaForm {
  readOnly: string; // '' | 'true' | 'false'
  dangerous: string;
  perms: string; // comma-separated
  daily: string;
  autoSafe: string;
  confirm: string;
  examplesRaw: string; // JSON array text
  examplesErr: string | null;
}

interface VReq {
  method: string;
  url: string;
  headers: string; // JSON text
  query: string; // JSON text
  body: string; // JSON text
}

interface Editing {
  id: string;
  kind: 'native' | 'composite' | 'virtual';
  name: string;
  meta?: MetaForm; // discovery metadata
  req?: VReq; // virtual request template
  executable?: boolean; // virtual: HTTP-proxied (true) vs descriptive catalog-only (false)
  respRaw?: string; // virtual descriptive: static response body
  respMode?: 'json' | 'text'; // how respRaw is interpreted
  displayName: string;
  description: string;
  params: Field[]; // inputSchema, as a recursive field tree
  required: string[];
  outParams: Field[]; // outputSchema, as a recursive field tree
  outRequired: string[];
  steps: Step[]; // composite
  output: unknown; // composite output template
  outMode: 'text' | 'json'; // composite output template mode
  right: 'json' | 'test';
  jsonRaw: string | null; // editable JSON override (null → derived from the form)
  jsonError: string | null;
  testVals: Record<string, unknown>;
  testOut: RunResult | null;
  testing: boolean;
  pickerStep: number | null;
  pickerQuery: string;
  stepSchemaOpen: Record<string, boolean>; // composite: "params" panel, keyed by step id
  stepTest: Record<string, { running?: boolean; out?: RunResult | null; err?: string }>;
}

export function ToolsTab() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [err, setErr] = useState('');

  const [search, setSearch] = useState('');
  const [fType, setFType] = useState<'all' | 'native' | 'composite'>('all');
  const [fSource, setFSource] = useState('');
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [ed, setEd] = useState<Editing | null>(null);
  const [outputRev, setOutputRev] = useState(0); // remount OutputField when JSON edits change `output`

  const load = () => api.get<Tool[]>('/tools').then(setTools).catch((e) => setErr(String(e.message)));
  useEffect(() => {
    void load();
    void api.get<Source[]>('/sources').then(setSources);
  }, []);

  const srcName = (id: string | null) => sources.find((s) => s.id === id)?.name ?? 'Unknown source';
  const patch = (p: Partial<Editing>) => setEd((e) => (e ? { ...e, ...p } : e));
  const setMeta = (p: Partial<MetaForm>) => setEd((e) => (e && e.meta ? { ...e, meta: { ...e.meta, ...p } } : e));
  const close = () => setEd(null);

  // composite registry key — derived from the display name, never typed by hand
  const slugName = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';

  // editing the display name: for a NEW composite the unique key tracks it live;
  // existing tools keep their key stable (renaming would break composite refs).
  const setDisplay = (v: string) =>
    setEd((e) => (e ? { ...e, displayName: v, jsonRaw: null, jsonError: null, ...(e.id === 'new' && (e.kind === 'composite' || e.kind === 'virtual') ? { name: slugName(v) } : {}) } : e));

  const openNewComposite = () =>
    setEd({
      id: 'new', kind: 'composite', name: slugName('New composite tool'), displayName: 'New composite tool', description: '',
      meta: { readOnly: '', dangerous: '', perms: '', daily: '', autoSafe: '', confirm: '', examplesRaw: '', examplesErr: null },
      params: [], required: [], outParams: [], outRequired: [], steps: [{ id: 's1', tool: '', args: {} }], output: 'Result: ${$.steps.s1.text}', outMode: 'text',
      right: 'json', jsonRaw: null, jsonError: null, testVals: {}, testOut: null, testing: false, pickerStep: null, pickerQuery: '', stepSchemaOpen: {}, stepTest: {},
    });

  const emptyMeta = (): MetaForm => ({ readOnly: '', dangerous: '', perms: '', daily: '', autoSafe: '', confirm: '', examplesRaw: '', examplesErr: null });

  const openNewVirtual = () =>
    setEd({
      id: 'new', kind: 'virtual', name: slugName('New virtual tool'), displayName: 'New virtual tool', description: '',
      meta: emptyMeta(), executable: true, respRaw: '', respMode: 'json',
      req: { method: 'GET', url: '', headers: '', query: '', body: '' },
      params: [], required: [], outParams: [], outRequired: [], steps: [], output: undefined, outMode: 'text',
      right: 'test', jsonRaw: null, jsonError: null, testVals: {}, testOut: null, testing: false, pickerStep: null, pickerQuery: '', stepSchemaOpen: {}, stepTest: {},
    });

  const open = async (t: Tool) => {
    if (ed?.id === t.id) return close();
    setErr('');
    const { params, required } = parseInput(t.inputSchema);
    const out = parseInput(t.outputSchema);
    const triS = (v: boolean | null | undefined) => (v == null ? '' : String(v));
    const ru = t.recommendedUse ?? {};
    const base: Editing = {
      id: t.id, kind: t.kind, name: t.name, displayName: t.displayName ?? '', description: t.description ?? '',
      meta: {
        readOnly: triS(t.readOnly), dangerous: triS(t.dangerous),
        perms: (t.permissions ?? []).join(', '),
        daily: triS(ru.daily_report), autoSafe: triS(ru.safe_for_automation), confirm: triS(ru.requires_user_confirmation),
        examplesRaw: t.examples?.length ? JSON.stringify(t.examples, null, 2) : '',
        examplesErr: null,
      },
      params, required,
      outParams: t.outputSchema ? out.params : [], outRequired: out.required,
      steps: [], output: undefined, outMode: 'text', right: 'json', jsonRaw: null, jsonError: null, testVals: {}, testOut: null, testing: false,
      pickerStep: null, pickerQuery: '', stepSchemaOpen: {}, stepTest: {},
    };
    setEd(base);
    if (t.kind === 'virtual') {
      const full = await api.get<{ request?: Cfg; executable?: boolean; response?: unknown }>(`/virtual-tools/${t.id}`);
      const rq = full.request ?? {};
      setEd((e) => (e && e.id === t.id ? {
        ...e,
        executable: full.executable ?? true,
        respMode: typeof full.response === 'string' ? 'text' : 'json',
        respRaw: full.response == null ? '' : typeof full.response === 'string' ? full.response : JSON.stringify(full.response, null, 2),
        req: {
          method: (rq.method as string) ?? 'GET',
          url: (rq.url as string) ?? '',
          headers: rq.headers ? JSON.stringify(rq.headers, null, 2) : '',
          query: rq.query ? JSON.stringify(rq.query, null, 2) : '',
          body: rq.body !== undefined ? JSON.stringify(rq.body, null, 2) : '',
        },
      } : e));
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
      setEd((e) => (e && e.id === t.id ? {
        ...e,
        params: inp.params, required: inp.required,
        outParams: outputSchema ? o.params : [], outRequired: o.required,
        steps: norm, output, outMode: output != null && typeof output === 'object' ? 'json' : 'text',
      } : e));
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
      permissions: m.perms.split(',').map((s) => s.trim()).filter(Boolean),
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
        const created = await api.post<{ id: string }>('/composite-tools', { name: e.name, definition, displayName: e.displayName || undefined, description: e.description || undefined });
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
      setErr('Invalid JSON: ' + (err as Error).message);
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
        setErr('Request headers/query/body must be valid JSON: ' + (err as Error).message);
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
          setErr('Response body must be valid JSON (or switch to Text): ' + (err as Error).message);
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
          name: e.name, displayName: e.displayName || undefined, description: e.description || undefined, inputSchema, outputSchema, executable,
          ...(request ? { request } : {}), ...(response !== undefined ? { response } : {}),
        });
        if (Object.keys(mb).length) await api.patch(`/tools/${created.id}`, mb);
        await load();
        close();
        return;
      }
      await api.patch(`/virtual-tools/${e.id}`, { executable, ...(request ? { request } : {}), ...(response !== undefined ? { response } : {}) });
      const idBody: Cfg = { displayName: e.displayName || null, description: e.description || null, inputSchema, outputSchema, ...mb };
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

  const runTest = async (e: Editing) => {
    setErr('');
    const missing = e.required.filter((name) => {
      const v = e.testVals[name];
      return v == null || v === '';
    });
    if (missing.length) {
      setErr(`Required: ${missing.join(', ')}`);
      return;
    }
    patch({ testing: true, testOut: null });
    try {
      const args: Cfg = {};
      for (const p of e.params) {
        const v = e.testVals[p.name];
        if (v !== undefined && v !== '') args[p.name] = v;
      }
      let r: RunResult;
      if (e.kind === 'virtual' && e.id === 'new' && e.req) {
        // unsaved draft: run statelessly (descriptive → returns the catalog entry)
        const rq = e.req;
        if (e.executable === false) {
          let response: unknown;
          const raw = (e.respRaw ?? '').trim();
          if (raw) {
            if (e.respMode === 'text') response = e.respRaw;
            else {
              try {
                response = JSON.parse(e.respRaw!);
              } catch (err) {
                patch({ testing: false });
                return setErr('Response body must be valid JSON (or switch to Text): ' + (err as Error).message);
              }
            }
          }
          r = await api.post<RunResult>('/virtual-tools/test', { executable: false, ...(response !== undefined ? { response } : {}) });
        } else {
          const request: Cfg = {
            method: rq.method,
            url: rq.url,
            ...(rq.headers.trim() ? { headers: JSON.parse(rq.headers) } : {}),
            ...(rq.query.trim() ? { query: JSON.parse(rq.query) } : {}),
            ...(rq.body.trim() ? { body: JSON.parse(rq.body) } : {}),
          };
          r = await api.post<RunResult>('/virtual-tools/test', { request, args });
        }
      } else {
        r = await api.post<RunResult>(`/tools/${e.id}/test`, { args });
      }
      patch({ testOut: r, testing: false });
    } catch (err) {
      patch({ testing: false });
      setErr(String((err as Error).message));
    }
  };

  // ----- editable tool JSON (two-way with the form) -----
  const onToolJson = (text: string) => {
    let p: Cfg;
    try {
      p = JSON.parse(text);
    } catch (err) {
      patch({ jsonRaw: text, jsonError: (err as Error).message });
      return;
    }
    const inp = parseInput(p.inputSchema);
    const out = parseInput(p.outputSchema);
    setEd((e) =>
      e
        ? {
            ...e,
            displayName: typeof p.displayName === 'string' ? p.displayName : e.displayName,
            description: typeof p.description === 'string' ? p.description : e.description,
            // composite key tracks display name only for a new draft
            ...(e.id === 'new' && e.kind === 'composite' && typeof p.displayName === 'string' ? { name: slugName(p.displayName) } : {}),
            params: p.inputSchema ? inp.params : [],
            required: p.inputSchema ? inp.required : [],
            outParams: p.outputSchema ? out.params : [],
            outRequired: p.outputSchema ? out.required : [],
            ...(e.kind === 'composite'
              ? {
                  steps: Array.isArray(p.steps)
                    ? p.steps.map((s: Cfg, i: number) => ({ id: s.id ?? `s${i + 1}`, tool: s.tool ?? '', args: s.args ?? {}, when: s.when }))
                    : e.steps,
                  output: 'output' in p ? p.output : e.output,
                  outMode: 'output' in p ? (p.output != null && typeof p.output === 'object' ? 'json' : 'text') : e.outMode,
                }
              : {}),
            jsonRaw: null,
            jsonError: null,
            testOut: null,
          }
        : e,
    );
    setOutputRev((r) => r + 1);
  };

  // ----- step editing (composite) -----
  const setSteps = (steps: Step[]) => patch({ steps, testOut: null, jsonRaw: null, jsonError: null });
  const updStep = (i: number, p: Partial<Step>) => ed && setSteps(ed.steps.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const addStep = () => ed && setSteps([...ed.steps, { id: `s${ed.steps.length + 1}`, tool: '', args: {} }]);
  const rmStep = (i: number) => ed && setSteps(ed.steps.filter((_, j) => j !== i));
  const setArg = (i: number, k: string, v: string) => ed && updStep(i, { args: { ...ed.steps[i].args, [k]: v } });
  const renameArg = (i: number, oldK: string, newK: string) => {
    if (!ed) return;
    const a = { ...ed.steps[i].args };
    const val = a[oldK];
    delete a[oldK];
    if (newK) a[newK] = val;
    updStep(i, { args: a });
  };
  const delArg = (i: number, k: string) => {
    if (!ed) return;
    if (stepToolInfo(ed.steps[i].tool).required.includes(k)) return; // required args are locked
    const a = { ...ed.steps[i].args };
    delete a[k];
    updStep(i, { args: a });
  };
  // referenced tool's input schema (params + required) for a step
  const stepToolInfo = (name: string) => {
    const tool = tools.find((t) => t.name === name);
    const { params, required } = parseInput(tool?.inputSchema);
    return { tool, params, required };
  };

  const pickTool = (i: number, name: string) => {
    if (!ed) return;
    const id = ed.steps[i].id;
    const { params } = stepToolInfo(name);
    const prev = ed.steps[i].args;
    const args: Record<string, string> = {};
    for (const p of params) args[p.name] = prev[p.name] ?? ''; // seed keys from the tool schema
    setSteps(ed.steps.map((s, j) => (j === i ? { ...s, tool: name, args } : s)));
    // changing the tool invalidates the old result/schema for this step
    const so = { ...ed.stepSchemaOpen }; delete so[id];
    const st = { ...ed.stepTest }; delete st[id];
    patch({ pickerStep: null, pickerQuery: '', stepSchemaOpen: so, stepTest: st });
  };

  const toggleStepSchema = (id: string) =>
    ed && patch({ stepSchemaOpen: { ...ed.stepSchemaOpen, [id]: !ed.stepSchemaOpen[id] } });

  const closeStepTest = (id: string) => {
    if (!ed) return;
    const st = { ...ed.stepTest }; delete st[id];
    patch({ stepTest: st });
  };

  // run a single step's tool with the literal args entered (refs won't resolve standalone)
  const runStepTest = async (i: number) => {
    if (!ed) return;
    const step = ed.steps[i];
    const id = step.id;
    const { tool, params } = stepToolInfo(step.tool);
    if (!tool) {
      patch({ stepTest: { ...ed.stepTest, [id]: { err: 'Pick a tool first' } } });
      return;
    }
    patch({ stepTest: { ...ed.stepTest, [id]: { running: true } } });
    const typeOf = (k: string) => params.find((p) => p.name === k)?.schema.type;
    const args: Cfg = {};
    for (const [k, v] of Object.entries(step.args)) {
      if (v === '' || v == null) continue;
      const t = typeOf(k);
      args[k] = (t === 'number' || t === 'integer') && !v.startsWith('$') ? Number(v) : v;
    }
    try {
      const out = await api.post<RunResult>(`/tools/${tool.id}/test`, { args });
      setEd((e) => (e ? { ...e, stepTest: { ...e.stepTest, [id]: { out } } } : e));
    } catch (err) {
      setEd((e) => (e ? { ...e, stepTest: { ...e.stepTest, [id]: { err: String((err as Error).message) } } } : e));
    }
  };

  // ----- filtering / grouping -----
  const filtered = tools.filter(
    (t) =>
      (!search || t.name.toLowerCase().includes(search.toLowerCase()) || (t.displayName ?? '').toLowerCase().includes(search.toLowerCase())) &&
      (fType === 'all' || t.kind === fType) &&
      (!fSource || t.sourceId === fSource),
  );

  const groups = useMemo(() => {
    const m = new Map<string, { key: string; label: string; composite: boolean; tools: Tool[] }>();
    for (const t of filtered) {
      const key = t.kind === 'composite' ? '__composite' : t.kind === 'virtual' ? '__virtual' : t.sourceId ?? '__none';
      if (!m.has(key)) {
        m.set(key, {
          key,
          label: t.kind === 'composite' ? 'Composite tools' : t.kind === 'virtual' ? 'Virtual tools' : srcName(t.sourceId),
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

  // ----- editor pane -----
  const editor = (e: Editing) => {
    const isComp = e.kind === 'composite';
    const isVirt = e.kind === 'virtual';
    const setReq = (p: Partial<VReq>) => setEd((x) => (x && x.req ? { ...x, req: { ...x.req, ...p } } : x));
    const pool = tools.filter((t) => t.name !== e.name);
    const pq = e.pickerQuery.toLowerCase();
    const assembled = JSON.stringify(
      {
        name: e.name, displayName: e.displayName || undefined, description: e.description || undefined,
        ...(e.params.length ? { inputSchema: buildInput(e.params, e.required) } : {}),
        ...(e.outParams.length ? { outputSchema: buildInput(e.outParams, e.outRequired) } : {}),
        ...(isComp ? { steps: e.steps.map((s) => ({ id: s.id, tool: s.tool, args: s.args, ...(s.when ? { when: s.when } : {}) })), output: e.output } : {}),
      },
      null,
      2,
    );

    return (
      <div className="editor-split">
        {/* LEFT: definition */}
        <div className="editor-left">
          <div className="editor-section">Definition</div>
          <div className="row" style={{ gap: 12, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <div className="field-label">Name · unique · {isComp ? 'from display name' : 'from source'} · locked</div>
              <input
                className="mono"
                style={{ width: '100%', opacity: 0.6, cursor: 'not-allowed' }}
                value={e.name}
                readOnly
                title={isComp ? 'Auto-generated from the display name. Can not be set by hand.' : 'Native tool key is tied to the source — relabel via Display name.'}
              />
            </div>
            <div style={{ flex: 1 }}>
              <div className="field-label">Display name</div>
              <input style={{ width: '100%' }} value={e.displayName} onChange={(ev) => setDisplay(ev.target.value)} placeholder="shown to agents" />
            </div>
          </div>
          <div className="field-label">Description · the model reads this</div>
          <textarea style={{ minHeight: 56, marginBottom: 14 }} value={e.description} onChange={(ev) => patch({ description: ev.target.value, jsonRaw: null, jsonError: null })} placeholder="what the tool does" />

          {isVirt && e.req && (
            <>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
                <span className="editor-section" style={{ margin: 0 }}>Endpoint</span>
                <span className="seg">
                  <span className={e.executable !== false ? 'on' : ''} onClick={() => patch({ executable: true })}>Executable</span>
                  <span className={e.executable === false ? 'on' : ''} onClick={() => patch({ executable: false })}>Descriptive</span>
                </span>
              </div>
              <div className="hint">
                {e.executable === false
                  ? 'Descriptive — no endpoint is called. Just schema/description/examples so agents know it exists (calling it returns the catalog entry).'
                  : 'Executable — the gateway makes this HTTP call. Use ${args.x} for arguments and ${secret.NAME} for secrets.'}
              </div>
            </>
          )}

          {isVirt && e.req && e.executable !== false && (
            <>
              <div className="row" style={{ gap: 8 }}>
                <select value={e.req.method} onChange={(ev) => setReq({ method: ev.target.value })} style={{ width: 110 }}>
                  {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <input className="grow mono" value={e.req.url} onChange={(ev) => setReq({ url: ev.target.value })} placeholder="https://api.example.com/v1/foo?id=${args.id}" />
              </div>
              <div className="field-label" style={{ marginTop: 10 }}>Headers · JSON (optional)</div>
              <textarea className="json-area mono" style={{ minHeight: 60 }} value={e.req.headers} onChange={(ev) => setReq({ headers: ev.target.value })} placeholder={'{ "authorization": "Bearer ${secret.API_TOKEN}" }'} />
              <div className="field-label" style={{ marginTop: 10 }}>Query · JSON (optional)</div>
              <textarea className="json-area mono" style={{ minHeight: 50 }} value={e.req.query} onChange={(ev) => setReq({ query: ev.target.value })} placeholder={'{ "limit": "${args.limit}" }'} />
              <div className="field-label" style={{ marginTop: 10 }}>Body · JSON (optional, non-GET)</div>
              <textarea className="json-area mono" style={{ minHeight: 70 }} value={e.req.body} onChange={(ev) => setReq({ body: ev.target.value })} placeholder={'{ "q": "${args.query}" }'} />
            </>
          )}

          <div className="field-label" style={{ marginTop: isVirt ? 14 : 0 }}>Input schema{isComp ? ' · reference as $.input.x' : ''}</div>
          <FieldRows
            fields={e.params}
            required={e.required}
            onChange={(params, required) => patch({ params, required, testOut: null, jsonRaw: null, jsonError: null })}
          />

          {!isComp && (
            <>
              <div className="field-label" style={{ marginTop: 16 }}>Output schema · optional</div>
              <FieldRows
                fields={e.outParams}
                required={e.outRequired}
                onChange={(outParams, outRequired) => patch({ outParams, outRequired, jsonRaw: null, jsonError: null })}
              />
            </>
          )}

          {isVirt && e.executable === false && (
            <>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
                <span className="field-label" style={{ margin: 0 }}>Response body · optional · returned on call</span>
                <span className="seg">
                  <span className={e.respMode !== 'text' ? 'on' : ''} onClick={() => patch({ respMode: 'json' })}>JSON</span>
                  <span className={e.respMode === 'text' ? 'on' : ''} onClick={() => patch({ respMode: 'text' })}>Text</span>
                </span>
              </div>
              <div className="hint">Static body the tool returns when called (no endpoint). Empty → returns the catalog entry.</div>
              <textarea
                className="json-area mono"
                style={{ minHeight: 90 }}
                value={e.respRaw ?? ''}
                onChange={(ev) => patch({ respRaw: ev.target.value })}
                placeholder={e.respMode === 'text' ? 'Any plain text the tool should return…' : '{ "projects": [ { "id": 1, "name": "Acme" } ] }'}
              />
            </>
          )}

          {e.meta && (
            <>
              <div className="editor-section" style={{ marginTop: 20 }}>Discovery metadata</div>
              <div className="hint">Helps agents call this tool safely & correctly — surfaced via <code className="mono">system.context</code>.</div>
              <div className="row" style={{ gap: 12 }}>
                {([['readOnly', 'Read-only'], ['dangerous', 'Dangerous']] as const).map(([k, label]) => (
                  <div key={k} style={{ flex: 1 }}>
                    <div className="field-label">{label}</div>
                    <select style={{ width: '100%' }} value={e.meta![k]} onChange={(ev) => setMeta({ [k]: ev.target.value })}>
                      <option value="">— unknown —</option>
                      <option value="true">yes</option>
                      <option value="false">no</option>
                    </select>
                  </div>
                ))}
              </div>
              <div className="field-label" style={{ marginTop: 10 }}>Permissions · comma-separated</div>
              <input style={{ width: '100%' }} value={e.meta.perms} onChange={(ev) => setMeta({ perms: ev.target.value })} placeholder="ga4.read, gmail.read" />
              <div className="field-label" style={{ marginTop: 10 }}>Recommended use · automation hints</div>
              <div className="row" style={{ gap: 12 }}>
                {([['daily', 'Daily report'], ['autoSafe', 'Safe for automation'], ['confirm', 'Needs confirmation']] as const).map(([k, label]) => (
                  <div key={k} style={{ flex: 1 }}>
                    <div className="field-label" style={{ fontWeight: 400 }}>{label}</div>
                    <select style={{ width: '100%' }} value={e.meta![k]} onChange={(ev) => setMeta({ [k]: ev.target.value })}>
                      <option value="">—</option>
                      <option value="true">yes</option>
                      <option value="false">no</option>
                    </select>
                  </div>
                ))}
              </div>
              <div className="field-label" style={{ marginTop: 10 }}>Examples · JSON array of {'{ description, input }'}</div>
              <textarea
                className="json-area mono"
                style={{ minHeight: 120 }}
                value={e.meta.examplesRaw}
                onChange={(ev) => setMeta({ examplesRaw: ev.target.value, examplesErr: null })}
                placeholder={'[\n  { "description": "7d traffic by date", "input": { "property": "properties/123", "dimensions": ["date"], "metrics": ["activeUsers"] } }\n]'}
              />
              {e.meta.examplesErr && <div className="err-msg">{e.meta.examplesErr}</div>}
            </>
          )}

          {isComp && (
            <>
              <div className="row" style={{ justifyContent: 'space-between', margin: '20px 0 8px' }}>
                <span className="editor-section" style={{ margin: 0 }}>Steps</span>
                <span className="hint" style={{ margin: 0 }}>each step calls another tool · refs <code>$.input.x</code> / <code>$.steps.s1.text</code></span>
              </div>
              {e.steps.map((st, i) => {
                const keys = Object.keys(st.args);
                const results = pool.filter((x) => !pq || x.name.toLowerCase().includes(pq) || (x.displayName ?? '').toLowerCase().includes(pq));
                const info = stepToolInfo(st.tool);
                const stp = e.stepTest[st.id];
                return (
                  <div key={i} className="step-card">
                    <div className="row" style={{ marginBottom: 10 }}>
                      <span className="step-num">{i + 1}</span>
                      <input style={{ width: 64 }} value={st.id} onChange={(ev) => updStep(i, { id: ev.target.value })} placeholder="id" />
                      <span className="step-tool" onClick={() => patch({ pickerStep: e.pickerStep === i ? null : i, pickerQuery: '' })}>
                        ⌕ {st.tool || '— pick tool —'} <span className="muted">▾</span>
                      </span>
                      {st.tool && (
                        <>
                          <span className="edit-link" onClick={() => toggleStepSchema(st.id)}>params</span>
                          <span className="step-test" onClick={() => runStepTest(i)}>{stp?.running ? <span className="spin" /> : '▶'} test</span>
                        </>
                      )}
                      <span className="inline-x" style={{ marginLeft: 'auto' }} onClick={() => rmStep(i)}>×</span>
                    </div>

                    {e.pickerStep === i && (
                      <div className="picker-pop">
                        <div className="ph">
                          <input autoFocus style={{ width: '100%' }} value={e.pickerQuery} onChange={(ev) => patch({ pickerQuery: ev.target.value })} placeholder="Search tool…" />
                        </div>
                        <div className="pl">
                          {results.map((x) => (
                            <div key={x.id} className="pi" onClick={() => pickTool(i, x.name)}>
                              <span className="mono" style={{ color: 'var(--accent)', fontSize: 12.5, fontWeight: 600 }}>{x.name}</span>
                              <span className="muted" style={{ fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.displayName ?? ''}</span>
                              <span className="tbadge">{x.kind === 'composite' ? 'composite' : x.kind === 'virtual' ? 'virtual' : srcName(x.sourceId)}</span>
                            </div>
                          ))}
                          {!results.length && <div className="muted" style={{ padding: 16, textAlign: 'center', fontSize: 12 }}>Nothing found</div>}
                        </div>
                      </div>
                    )}

                    {keys.map((k) => {
                      const req = info.required.includes(k);
                      return (
                        <div key={k} className="row" style={{ marginBottom: 6, paddingLeft: 30 }}>
                          <input style={{ width: 120, ...(req ? { opacity: 0.7 } : {}) }} className="mono" value={k} readOnly={req} onChange={(ev) => renameArg(i, k, ev.target.value)} title={req ? 'required' : ''} />
                          <span className="muted">=</span>
                          <input className="grow mono" value={st.args[k]} onChange={(ev) => setArg(i, k, ev.target.value)} placeholder={req ? 'required · value or $.input.x' : 'value or $.input.x'} />
                          {req ? <span style={{ width: 18 }} /> : <span className="inline-x" onClick={() => delArg(i, k)}>×</span>}
                        </div>
                      );
                    })}
                    {!keys.length && st.tool && <div className="hint" style={{ paddingLeft: 30, margin: 0 }}>no arguments</div>}
                    <div style={{ paddingLeft: 30 }}>
                      <button className="ghost mini" onClick={() => setArg(i, `arg${keys.length + 1}`, '')}>+ arg</button>
                    </div>

                    <div className="row" style={{ marginTop: 8, paddingLeft: 30, alignItems: 'center' }}>
                      <span className="muted" style={{ fontSize: 11.5, minWidth: 62 }}>when</span>
                      <input className="grow mono" value={st.when ?? ''} onChange={(ev) => updStep(i, { when: ev.target.value || undefined })} placeholder="optional gate · $.input.flag (or !$.input.flag)" />
                    </div>

                    {e.stepSchemaOpen[st.id] && (
                      <div className="step-schema">
                        <div className="row" style={{ justifyContent: 'space-between' }}>
                          <div className="step-schema-head">PARAMETERS</div>
                          <span className="inline-x" onClick={() => toggleStepSchema(st.id)}>×</span>
                        </div>
                        {info.params.length ? info.params.map((p) => (
                          <div key={p.name} className="step-schema-row">
                            <span className="mono" style={{ color: 'var(--accent)', minWidth: 90 }}>{p.name}</span>
                            <span className="muted" style={{ minWidth: 60 }}>{p.schema.type}{info.required.includes(p.name) ? ' · req' : ''}</span>
                            <span className="muted">{p.schema.description}</span>
                          </div>
                        )) : <div className="muted" style={{ fontSize: 11.5 }}>no parameters</div>}
                        {info.tool?.outputSchema && (
                          <>
                            <div className="step-schema-head" style={{ marginTop: 10 }}>OUTPUT SCHEMA</div>
                            <pre className="code-block">{JSON.stringify(info.tool.outputSchema, null, 2)}</pre>
                          </>
                        )}
                      </div>
                    )}

                    {stp && !stp.running && (stp.out || stp.err) && (
                      <div style={{ marginTop: 10, marginLeft: 30 }}>
                        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                          <span className="step-schema-head" style={{ margin: 0 }}>RESULT</span>
                          <span className="inline-x" onClick={() => closeStepTest(st.id)}>×</span>
                        </div>
                        {stp.err ? (
                          <div className="err-msg" style={{ margin: 0 }}>{stp.err}</div>
                        ) : (
                          <pre className="code-block" style={{ maxHeight: 200, color: stp.out!.isError ? 'var(--err)' : undefined }}>
                            {(stp.out!.isError ? '[error] ' : '') + (stp.out!.content?.[0]?.text ?? '(empty)')}
                          </pre>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              <button className="ghost mini" onClick={addStep} style={{ marginBottom: 18 }}>+ Add step</button>

              <div className="editor-section">Output (optional)</div>
              <div className="hint"><b>text</b> = string template · <b>json</b> = object template (structured). Empty → raw last step.</div>
              <OutputField
                key={`${e.id}-${outputRev}`}
                value={e.output}
                onChange={(v) => patch({ output: v, testOut: null, jsonRaw: null, jsonError: null })}
                onMode={(m) => patch({ outMode: m })}
              />
              {e.outMode === 'json' && (
                <>
                  <div className="field-label" style={{ marginTop: 14 }}>Output schema · optional</div>
                  <FieldRows
                    fields={e.outParams}
                    required={e.outRequired}
                    onChange={(outParams, outRequired) => patch({ outParams, outRequired, jsonRaw: null, jsonError: null })}
                  />
                </>
              )}
            </>
          )}

          {/* actions */}
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }} className="row">
            <button className="btn-primary" onClick={() => (isComp ? saveComposite(e) : isVirt ? saveVirtual(e) : saveNative(e))}>
              {e.id === 'new' ? 'Create tool' : 'Save changes'}
            </button>
            <button className="ghost" onClick={close}>Cancel</button>
            {e.id !== 'new' && <button className="danger" style={{ marginLeft: 'auto' }} onClick={() => del(e.id)}>Delete</button>}
          </div>
          {err && <div className="err-msg">{err}</div>}
        </div>

        {/* RIGHT: JSON | Test */}
        <div className="editor-right">
          <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 12 }}>
            <span className="seg">
              <span className={e.right === 'json' ? 'on' : ''} onClick={() => patch({ right: 'json' })}>JSON</span>
              <span className={e.right === 'test' ? 'on' : ''} onClick={() => patch({ right: 'test' })}>Test run</span>
            </span>
          </div>

          {e.right === 'json' ? (
            <>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                <span className="field-label" style={{ margin: 0 }}>Config · JSON</span>
                <span className="tbadge">edits ↔ form</span>
              </div>
              <textarea
                className="json-area"
                spellCheck={false}
                value={e.jsonRaw != null ? e.jsonRaw : assembled}
                onChange={(ev) => onToolJson(ev.target.value)}
              />
              {e.jsonError ? (
                <div className="err-msg" style={{ marginTop: 8 }}>⚠ {e.jsonError}</div>
              ) : (
                <div className="hint" style={{ marginTop: 8 }}>Edits here update the form. Name is locked.</div>
              )}
            </>
          ) : (
            <>
              <div className="hint">{isComp ? 'runs the whole tool — all steps in order' : 'one call with test arguments'}</div>
              {e.params.map((p, i) => (
                <div key={i} style={{ marginBottom: 10 }}>
                  <div className="field-label" style={{ marginBottom: 4 }}>
                    <span className="mono" style={{ color: 'var(--text)' }}>{p.name || '(unnamed)'}</span>{' '}
                    <span style={{ fontWeight: 400 }}>{p.schema.type}{e.required.includes(p.name) ? ' · required' : ''}</span>
                  </div>
                  <ValueInput
                    schema={p.schema}
                    value={e.testVals[p.name]}
                    invalid={e.required.includes(p.name) && (e.testVals[p.name] === undefined || e.testVals[p.name] === '')}
                    onChange={(v) => patch({ testVals: { ...e.testVals, [p.name]: v } })}
                  />
                </div>
              ))}
              {!e.params.length && <div className="hint">Tool takes no input parameters.</div>}
              <div className="spacer" />
              <button className="btn-primary" onClick={() => runTest(e)} disabled={e.testing || (e.id === 'new' && !isVirt)}>
                {e.testing ? <span className="spin" /> : '▶'} {isComp ? 'Run full tool' : 'Run test'}
              </button>
              {e.id === 'new' && !isVirt && <div className="hint" style={{ marginTop: 6 }}>Create the tool first to test it.</div>}
              {e.id === 'new' && isVirt && <div className="hint" style={{ marginTop: 6 }}>Runs the request without saving.</div>}
              {err && <div className="err-msg">{err}</div>}

              {e.testOut && (
                <div style={{ marginTop: 16 }}>
                  {e.testOut.steps && e.testOut.steps.length > 0 && (
                    <>
                      <div className="editor-section">Trace</div>
                      {e.testOut.steps.map((s) => (
                        <div key={s.id} className="trace-item">
                          <span className="dot" style={{ background: s.isError ? 'var(--err)' : 'var(--ok)' }} />
                          <div style={{ fontSize: 12, marginBottom: 4 }}>
                            <span className="muted">{s.id}</span> <span className="mono" style={{ color: 'var(--accent)' }}>{s.tool}</span>{' '}
                            <span className={`badge ${s.isError ? 'err' : 'ok'}`}>{s.skipped ? 'skip' : s.isError ? 'err' : 'ok'}</span>
                          </div>
                          <pre className="code-block">{s.text || '(empty)'}</pre>
                        </div>
                      ))}
                    </>
                  )}
                  <div className="editor-section">Output{e.testOut.isError ? ' · error' : ''}</div>
                  <pre className="code-block" style={{ color: e.testOut.isError ? 'var(--err)' : undefined }}>
                    {e.testOut.content?.[0]?.text ?? '(empty)'}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="intro">
        <b>Tools</b> — everything from your sources. <b>native</b> = one direct call (appear after Import). <b>composite</b> =
        one tool that internally makes several calls. Click a row to edit, toggle the switch to show/hide from agents.
      </div>

      <div className="page-head">
        <div>
          <span className="title">Tools</span>
          <span className="sub">{tools.length} tools · {visibleTotal} visible to agents</span>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn-primary" onClick={openNewVirtual}>+ New virtual tool</button>
          <button className="btn-primary" onClick={openNewComposite}>+ New composite tool</button>
        </div>
      </div>

      {/* draft composite */}
      {ed?.id === 'new' && (
        <div className="scard open" style={{ marginBottom: 18 }}>
          <div className="scard-head">
            <span className="mono" style={{ fontSize: 13.5, fontWeight: 600, color: '#b48cf0' }}>{ed.name || 'new_tool'}</span>
            <span className="tbadge composite">{ed.kind} · draft</span>
            <span className="edit-link" style={{ marginLeft: 'auto' }} onClick={close}>Close</span>
            <span className="chev up">⌄</span>
          </div>
          <div className="scard-body">{editor(ed)}</div>
        </div>
      )}

      {/* toolbar */}
      <div className="chip-row">
        <span className="chip-search">
          <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }}>⌕</span>
          <input style={{ width: '100%', paddingLeft: 28 }} placeholder="Search by name…" value={search} onChange={(e) => setSearch(e.target.value)} />
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
            <option key={s.id} value={s.id}>{s.name}</option>
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
            {isOpen && g.tools.map((t) => {
              const rowOpen = ed?.id === t.id;
              const comp = t.kind === 'composite';
              return (
                <div key={t.id} className={`scard ${rowOpen ? 'open' : ''}`}>
                  <div className="scard-head" onClick={() => open(t)}>
                    <span className={`switch ${t.visible ? 'on' : ''}`} onClick={(ev) => { ev.stopPropagation(); toggleVisible(t); }}><span className="knob" /></span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 11, flex: 1, minWidth: 0 }}>
                      <span className="mono" style={{ fontSize: 13.5, fontWeight: 600, color: comp ? '#b48cf0' : 'var(--accent)' }}>{t.name}</span>
                      <span className="muted" style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.displayName ?? ''}</span>
                    </span>
                    <span className={`tbadge tool-badge ${comp ? 'composite' : ''}`}>{comp ? 'composite' : 'native'}</span>
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
