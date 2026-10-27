import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
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
    <th className={`th-sort${active ? ' on' : ''}`}>
      <button type="button" onClick={() => sort.toggle(id)}>
        {label}
        <span className="th-arrow">{active ? (sort.dir === 1 ? '↑' : '↓') : ''}</span>
      </button>
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

export function Sparkline({ points, title }: { points: number[]; title?: string }) {
  const w = 100;
  const h = 28;
  const pad = 2;
  const max = Math.max(...points, 1);
  const step = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;
  const pts = points.map((v, i) => `${pad + i * step},${h - pad - (v / max) * (h - pad * 2)}`).join(' ');
  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-hidden={title ? undefined : 'true'}
    >
      {title && <title>{title}</title>}
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
  const confirm = (msg: string, label = 'Delete') => {
    if (state) state.resolve(false);
    return new Promise<boolean>((resolve) => setState({ msg, label, resolve }));
  };
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

/** Right-side editor panel. Closes on ×, backdrop click, or Esc (not while typing); asks first when `dirty`. */
export function Drawer({
  title,
  badge,
  dirty = false,
  onClose,
  children,
}: {
  title: ReactNode;
  badge?: ReactNode;
  dirty?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const { confirm, element: confirmEl } = useConfirm();
  const requestClose = async () => {
    if (!dirty || (await confirm('Discard unsaved changes?', 'Discard'))) onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === 'Escape' && !t?.closest('input, textarea, select, .modal')) void requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <>
      {/* mousedown, not click: a text selection dragged out of the drawer must not close it */}
      <div className="drawer-overlay" onMouseDown={(e) => e.target === e.currentTarget && void requestClose()}>
        <aside className="drawer" role="dialog" aria-modal="true">
          <header className="drawer-head">
            <span className="drawer-title">{title}</span>
            {badge}
            {dirty && <span className="badge muted">unsaved</span>}
            <button
              className="icon-btn ml-auto"
              onClick={() => void requestClose()}
              title="Close (Esc)"
              aria-label="Close"
            >
              <Icon name="x" size={16} />
            </button>
          </header>
          <div className="drawer-body">{children}</div>
        </aside>
      </div>
      {confirmEl}
    </>
  );
}

/** True once the picked (saveable) part of `ed` differs from how it looked when this id was opened. */
export function useDirty<T extends { id: string }>(ed: T | null, pick: (e: T) => unknown): boolean {
  const base = useRef<{ id: string; snap: string } | null>(null);
  if (!ed) {
    base.current = null;
    return false;
  }
  const snap = JSON.stringify(pick(ed));
  // new id = freshly opened, or a draft just got created → that state is the clean baseline
  if (base.current?.id !== ed.id) base.current = { id: ed.id, snap };
  return base.current.snap !== snap;
}

/** Keeps `#/<page>/<id>` in sync with the open drawer, and reopens it from the URL once `rows` load. */
export function useItemRoute<T extends { id: string }>(
  openId: string | null | undefined,
  rows: T[] | null,
  open: (row: T) => void,
) {
  const pending = useRef<string | null>(location.hash.split('/')[2] ?? null);
  useEffect(() => {
    if (!rows || !pending.current) return;
    const row = rows.find((r) => r.id === pending.current);
    pending.current = null;
    if (row) open(row);
  }, [rows]);
  useEffect(() => {
    if (pending.current) return;
    const page = location.hash.split('/')[1];
    if (!page) return;
    const id = openId && openId !== 'new' ? `/${openId}` : '';
    // replaceState: no hashchange event, no history entry per drawer
    history.replaceState(null, '', `#/${page}${id}`);
  }, [openId]);
}
