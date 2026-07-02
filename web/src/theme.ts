const KEY = 'comind_theme';
export type Theme = 'light' | 'dark';

function apply(t: Theme) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem(KEY, t);
}

export function getTheme(): Theme {
  return (document.documentElement.dataset.theme as Theme) || 'light';
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'light' ? 'dark' : 'light';
  apply(next);
  return next;
}

export function initTheme(): void {
  const saved = localStorage.getItem(KEY) as Theme | null;
  apply(saved ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
}
