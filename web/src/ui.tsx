import { type ReactNode, useState } from 'react';

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
        <button className="ghost" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
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

export function Advanced({ summary = 'Advanced', children }: { summary?: string; children: ReactNode }) {
  return (
    <details className="advanced">
      <summary>{summary}</summary>
      <div className="advanced-body">{children}</div>
    </details>
  );
}
