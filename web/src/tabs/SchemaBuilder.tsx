import type { ReactNode } from 'react';

export type Cfg = Record<string, any>;
export const PARAM_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array'];

/** A JSON-schema node, recursive. `rest` keeps extra keys (pattern, enum, format…)
 *  so round-tripping through the UI is lossless. */
export interface SchemaNode {
  type: string;
  description: string;
  properties: Field[]; // object
  required: string[]; // object
  items: SchemaNode | null; // array
  rest: Cfg;
}
export interface Field {
  name: string;
  schema: SchemaNode;
}

export function emptyNode(type = 'string'): SchemaNode {
  return { type, description: '', properties: [], required: [], items: null, rest: {} };
}

export function parseNode(raw: unknown): SchemaNode {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Cfg;
  const { type, description, properties, required, items, ...rest } = d;
  const props: Field[] =
    properties && typeof properties === 'object'
      ? Object.entries(properties as Cfg).map(([name, v]) => ({ name, schema: parseNode(v) }))
      : [];
  return {
    type: typeof type === 'string' ? type : 'string',
    description: typeof description === 'string' ? description : '',
    properties: props,
    required: Array.isArray(required) ? required.filter((x) => typeof x === 'string') : [],
    items: items != null ? parseNode(items) : null,
    rest,
  };
}

export function buildNode(n: SchemaNode): Cfg {
  const out: Cfg = { type: n.type, ...n.rest };
  if (n.description) out.description = n.description;
  if (n.type === 'object') {
    const props: Cfg = {};
    for (const f of n.properties) if (f.name) props[f.name] = buildNode(f.schema);
    out.properties = props;
    const req = n.required.filter((r) => n.properties.some((f) => f.name === r));
    if (req.length) out.required = req;
  }
  if (n.type === 'array') out.items = n.items ? buildNode(n.items) : { type: 'string' };
  return out;
}

/** top-level inputSchema (object) → fields + required */
export function parseInput(schema: unknown): { params: Field[]; required: string[] } {
  const root = parseNode(schema && typeof schema === 'object' ? schema : { type: 'object' });
  return { params: root.properties, required: root.required };
}
export function buildInput(params: Field[], required: string[]): Cfg {
  return buildNode({ type: 'object', description: '', properties: params, required, items: null, rest: {} });
}

// ---------------------------------------------------------------------------
// Schema editor (recursive)
// ---------------------------------------------------------------------------

/** Editable list of object properties. Used at top level and for nested objects. */
export function FieldRows({
  fields,
  required,
  onChange,
  depth = 0,
}: {
  fields: Field[];
  required: string[];
  onChange: (fields: Field[], required: string[]) => void;
  depth?: number;
}): ReactNode {
  const setField = (i: number, schema: SchemaNode) =>
    onChange(
      fields.map((f, j) => (j === i ? { ...f, schema } : f)),
      required,
    );
  const rename = (i: number, name: string) => {
    const old = fields[i].name;
    onChange(
      fields.map((f, j) => (j === i ? { ...f, name } : f)),
      required.map((r) => (r === old ? name : r)),
    );
  };
  const remove = (i: number) => {
    const gone = fields[i].name;
    onChange(
      fields.filter((_, j) => j !== i),
      required.filter((r) => r !== gone),
    );
  };
  const add = () => onChange([...fields, { name: '', schema: emptyNode() }], required);
  const toggleReq = (name: string) =>
    onChange(fields, required.includes(name) ? required.filter((r) => r !== name) : [...required, name]);

  return (
    <div style={depth ? { marginLeft: 14, paddingLeft: 12, borderLeft: '1px solid var(--border)' } : undefined}>
      {fields.map((f, i) => (
        <div key={i} style={{ marginBottom: 8 }}>
          <div className="row" style={{ alignItems: 'center' }}>
            <input
              style={{ width: 120 }}
              className="mono"
              value={f.name}
              onChange={(e) => rename(i, e.target.value)}
              placeholder="name"
            />
            <TypeSelect value={f.schema.type} onChange={(t) => setField(i, changeType(f.schema, t))} />
            <input
              className="grow"
              value={f.schema.description}
              onChange={(e) => setField(i, { ...f.schema, description: e.target.value })}
              placeholder="description"
            />
            <label
              className="muted"
              style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4 }}
              title="required"
            >
              <input type="checkbox" checked={required.includes(f.name)} onChange={() => toggleReq(f.name)} /> req
            </label>
            <span className="inline-x" onClick={() => remove(i)}>
              ×
            </span>
          </div>
          <NodeChildren schema={f.schema} onChange={(s) => setField(i, s)} depth={depth + 1} />
        </div>
      ))}
      <button className="ghost mini" onClick={add}>
        + {depth ? 'field' : 'param'}
      </button>
    </div>
  );
}

/** Renders the nested structure of a node (object props / array items). */
function NodeChildren({
  schema,
  onChange,
  depth,
}: {
  schema: SchemaNode;
  onChange: (s: SchemaNode) => void;
  depth: number;
}): ReactNode {
  if (schema.type === 'object') {
    return (
      <FieldRows
        fields={schema.properties}
        required={schema.required}
        depth={depth}
        onChange={(properties, required) => onChange({ ...schema, properties, required })}
      />
    );
  }
  if (schema.type === 'array') {
    const items = schema.items ?? emptyNode();
    return (
      <div style={{ marginLeft: 14, paddingLeft: 12, borderLeft: '1px solid var(--border)', marginTop: 6 }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: 11, minWidth: 40 }}>
            items
          </span>
          <TypeSelect value={items.type} onChange={(t) => onChange({ ...schema, items: changeType(items, t) })} />
          <input
            className="grow"
            value={items.description}
            onChange={(e) => onChange({ ...schema, items: { ...items, description: e.target.value } })}
            placeholder="item description"
          />
        </div>
        <NodeChildren schema={items} onChange={(s) => onChange({ ...schema, items: s })} depth={depth + 1} />
      </div>
    );
  }
  return null;
}

function TypeSelect({ value, onChange }: { value: string; onChange: (t: string) => void }) {
  return (
    <select
      style={{ width: 100 }}
      value={PARAM_TYPES.includes(value) ? value : 'string'}
      onChange={(e) => onChange(e.target.value)}
    >
      {PARAM_TYPES.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

/** Switch a node's type, seeding nested containers and preserving scalar extras. */
function changeType(node: SchemaNode, type: string): SchemaNode {
  const next: SchemaNode = { ...node, type };
  if (type === 'object' && !node.properties.length) next.properties = [];
  if (type === 'array' && !node.items) next.items = emptyNode();
  return next;
}

// ---------------------------------------------------------------------------
// Value form (recursive) — builds an actual value matching a schema node
// ---------------------------------------------------------------------------

export function ValueInput({
  schema,
  value,
  onChange,
  invalid,
}: {
  schema: SchemaNode;
  value: unknown;
  onChange: (v: unknown) => void;
  invalid?: boolean;
}): ReactNode {
  const errStyle = invalid ? { borderColor: 'var(--err)' } : {};

  if (schema.type === 'boolean') {
    return (
      <select
        style={{ width: '100%', ...errStyle }}
        value={value === true ? 'true' : value === false ? 'false' : ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value === 'true')}
      >
        <option value="">—</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    return (
      <input
        style={{ width: '100%', ...errStyle }}
        inputMode="decimal"
        value={value == null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        placeholder={schema.description || schema.type}
      />
    );
  }

  if (schema.type === 'object') {
    const obj = (value && typeof value === 'object' ? value : {}) as Cfg;
    return (
      <div style={{ marginLeft: 12, paddingLeft: 10, borderLeft: '1px solid var(--border)' }}>
        {schema.properties.map((f, i) => (
          <div key={i} style={{ marginBottom: 8 }}>
            <div className="field-label" style={{ marginBottom: 4 }}>
              <span className="mono" style={{ color: 'var(--text)' }}>
                {f.name || '(unnamed)'}
              </span>{' '}
              <span style={{ fontWeight: 400 }}>
                {f.schema.type}
                {schema.required.includes(f.name) ? ' · required' : ''}
              </span>
            </div>
            <ValueInput schema={f.schema} value={obj[f.name]} onChange={(v) => onChange({ ...obj, [f.name]: v })} />
          </div>
        ))}
        {!schema.properties.length && (
          <div className="hint" style={{ margin: 0 }}>
            no fields
          </div>
        )}
      </div>
    );
  }

  if (schema.type === 'array') {
    const arr = Array.isArray(value) ? value : [];
    const items = schema.items ?? emptyNode();
    return (
      <div style={{ marginLeft: 12, paddingLeft: 10, borderLeft: '1px solid var(--border)' }}>
        {arr.map((it: unknown, i: number) => (
          <div key={i} style={{ marginBottom: 8 }}>
            <div className="field-label" style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="muted">#{i + 1}</span>
              <span className="inline-x" onClick={() => onChange(arr.filter((_, j) => j !== i))}>
                ×
              </span>
            </div>
            <ValueInput schema={items} value={it} onChange={(v) => onChange(arr.map((x, j) => (j === i ? v : x)))} />
          </div>
        ))}
        <button
          className="ghost mini"
          onClick={() => onChange([...arr, items.type === 'object' ? {} : items.type === 'array' ? [] : undefined])}
        >
          + item
        </button>
      </div>
    );
  }

  // string (default)
  return (
    <input
      style={{ width: '100%', ...errStyle }}
      value={value == null ? '' : String(value)}
      onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
      placeholder={schema.description || 'string'}
    />
  );
}
