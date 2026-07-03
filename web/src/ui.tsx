import { type ReactNode, useMemo, useState } from 'react';
import { Icon } from './icons.js';

export type SortDir = 1 | -1;

export function useSort<T>(
  rows: T[],
  get: Record<string, (r: T) => string | number | boolean | null | undefined>,
  initialKey?: string,
  initialDir: SortDir = 1,
) {
  const [key, setKey] = useState<string | null>(initialKey ?? null);
  const [dir, setDir] = useState<SortDir>(initialDir);
  const toggle = (k: string) => {
    if (k === key) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setKey(k);
      setDir(1);
    }
  };
  const sorted = useMemo(() => {
    if (!key || !get[key]) return rows;
    const g = get[key];
    return [...rows].sort((a, b) => {
      const va = g(a);
      const vb = g(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [rows, key, dir, get]);
  return { sorted, key, dir, toggle };
}

export function Th({
  id,
  label,
  sort,
}: {
  id: string;
  label: string;
  sort: { key: string | null; dir: SortDir; toggle: (k: string) => void };
}) {
  const active = sort.key === id;
  return (
    <th className={`th-sort${active ? ' on' : ''}`} onClick={() => sort.toggle(id)}>
      {label}
      <span className="th-arrow">{active ? (sort.dir === 1 ? '↑' : '↓') : ''}</span>
    </th>
  );
}

export function CopyRow({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <div>
      {label && <div className="field-label">{label}</div>}
      <div className="copy-row">
        <div className="copy-row-text mono">{text}</div>
        <button className={`icon-btn${copied ? ' ok' : ''}`} onClick={copy} title="Copy" aria-label="Copy">
          <Icon name={copied ? 'check' : 'copy'} size={15} />
        </button>
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state-title">{title}</div>
      <div className="empty-state-body">{body}</div>
      {actionLabel && onAction && (
        <button className="btn-primary" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export function Loading() {
  return (
    <div className="loading text-muted">
      <span className="spin" /> Loading…
    </div>
  );
}

export function Sparkline({ points }: { points: number[] }) {
  const w = 100;
  const h = 28;
  const pad = 2;
  const max = Math.max(...points, 1);
  const step = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;
  const pts = points.map((v, i) => `${pad + i * step},${h - pad - (v / max) * (h - pad * 2)}`).join(' ');
  return (
    <svg className="sparkline" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function useConfirm() {
  const [state, setState] = useState<{
    msg: string;
    label: string;
    resolve: (v: boolean) => void;
  } | null>(null);
  const confirm = (msg: string, label = 'Delete') =>
    new Promise<boolean>((resolve) => setState({ msg, label, resolve }));
  const settle = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  const element = state ? (
    <div className="modal-overlay" onClick={() => settle(false)}>
      <div className="modal modal-confirm" onClick={(e) => e.stopPropagation()}>
        <p className="confirm-msg">{state.msg}</p>
        <div className="confirm-actions">
          <button className="ghost" onClick={() => settle(false)}>
            Cancel
          </button>
          <button className="danger" onClick={() => settle(true)}>
            {state.label}
          </button>
        </div>
      </div>
    </div>
  ) : null;
  return { confirm, element };
}

export function Advanced({ summary = 'Advanced', children }: { summary?: string; children: ReactNode }) {
  return (
    <details className="advanced">
      <summary>{summary}</summary>
      <div className="advanced-body">{children}</div>
    </details>
  );
}
