import { useState } from 'react';
import { api, type Tool } from '../api.js';
import { parseInput, ValueInput } from './SchemaBuilder.js';
import type { RunResult } from './ToolEditor.js';

const kindLabel = (k: Tool['kind']) => (k === 'composite' ? 'Recipe' : k);

export function ToolView({
  tool,
  sourceName,
  onEdit,
  onClose,
}: {
  tool: Tool;
  sourceName: string;
  onEdit: () => void;
  onClose: () => void;
}) {
  const { params, required } = parseInput(tool.inputSchema);
  const [vals, setVals] = useState<Record<string, unknown>>({});
  const [out, setOut] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState('');

  const run = async () => {
    setErr('');
    setRunning(true);
    setOut(null);
    try {
      const args: Record<string, unknown> = {};
      for (const p of params) {
        const v = vals[p.name];
        if (v !== undefined && v !== '') args[p.name] = v;
      }
      const r = await api.post<RunResult>(`/tools/${tool.id}/test`, { args });
      setOut(r);
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>{tool.displayName || tool.name}</h3>
          <span className={`tbadge ${tool.kind === 'composite' ? 'composite' : ''}`}>{kindLabel(tool.kind)}</span>
          <span className="tbadge">{sourceName}</span>
        </div>
        <div className="mono tool-subname">{tool.name}</div>
        {tool.description && <p className="hint">{tool.description}</p>}

        {(tool.readOnly != null || tool.dangerous != null || (tool.permissions?.length ?? 0) > 0) && (
          <div className="row" style={{ gap: 6, marginBottom: 8 }}>
            {tool.readOnly != null && <span className="badge muted">{tool.readOnly ? 'read-only' : 'writes'}</span>}
            {tool.dangerous != null && (
              <span className={`badge ${tool.dangerous ? 'err' : 'muted'}`}>
                {tool.dangerous ? 'dangerous' : 'safe'}
              </span>
            )}
            {tool.permissions?.map((p) => (
              <span key={p} className="badge muted">
                {p}
              </span>
            ))}
          </div>
        )}

        {!!tool.examples?.length && (
          <div className="row" style={{ gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
            {tool.examples.map((ex, i) => (
              <button key={i} className="ghost mini" onClick={() => setVals(ex.input ?? {})}>
                Use example{ex.description ? `: ${ex.description}` : ` ${i + 1}`}
              </button>
            ))}
          </div>
        )}

        <div className="editor-section">Inputs</div>
        {params.map((p, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            <div className="field-label mb-4">
              <span className="mono" style={{ color: 'var(--text)' }}>
                {p.name || '(unnamed)'}
              </span>{' '}
              <span className="fw-400">
                {p.schema.type}
                {required.includes(p.name) ? ' · required' : ''}
              </span>
            </div>
            <ValueInput
              schema={p.schema}
              value={vals[p.name]}
              invalid={required.includes(p.name) && (vals[p.name] === undefined || vals[p.name] === '')}
              onChange={(v) => setVals((s) => ({ ...s, [p.name]: v }))}
            />
          </div>
        ))}
        {!params.length && <div className="hint">Tool takes no input parameters.</div>}

        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn-primary" onClick={run} disabled={running}>
            {running ? <span className="spin" /> : '▶'} Run
          </button>
        </div>
        {err && <div className="err-msg">{err}</div>}

        {out && (
          <div style={{ marginTop: 16 }}>
            <div className="editor-section">Output{out.isError ? ' · error' : ''}</div>
            <pre className="mono" style={{ color: out.isError ? 'var(--err)' : undefined }}>
              {out.content?.map((c) => c.text ?? '').join('\n') || '(empty)'}
            </pre>
          </div>
        )}

        <div className="row divider-top" style={{ marginTop: 16 }}>
          <button className="ghost" onClick={onEdit}>
            Edit tool
          </button>
          <button className="btn-primary ml-auto" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
