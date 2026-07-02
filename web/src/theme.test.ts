import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTheme, initTheme, toggleTheme } from './theme.js';

const KEY = 'comind_theme';

function mockMatchMedia(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset.theme = '';
  mockMatchMedia(false);
});

describe('initTheme', () => {
  it('restores a saved theme from localStorage', () => {
    localStorage.setItem(KEY, 'dark');
    initTheme();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('falls back to prefers-color-scheme when nothing is saved', () => {
    mockMatchMedia(true);
    initTheme();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem(KEY)).toBe('dark');
  });

  it('falls back to light when prefers-color-scheme does not match', () => {
    mockMatchMedia(false);
    initTheme();
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('getTheme', () => {
  it('reads the current theme off the document element', () => {
    document.documentElement.dataset.theme = 'dark';
    expect(getTheme()).toBe('dark');
  });

  it('defaults to light when unset', () => {
    document.documentElement.dataset.theme = '';
    expect(getTheme()).toBe('light');
  });
});

describe('toggleTheme', () => {
  it('flips light to dark, updates the DOM, and persists', () => {
    document.documentElement.dataset.theme = 'light';
    const result = toggleTheme();
    expect(result).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem(KEY)).toBe('dark');
  });

  it('flips dark to light, updates the DOM, and persists', () => {
    document.documentElement.dataset.theme = 'dark';
    const result = toggleTheme();
    expect(result).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(KEY)).toBe('light');
  });
});
