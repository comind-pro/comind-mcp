import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpConnector } from './http.js';

function mockFetch(): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const connector = (path: string) =>
  new HttpConnector({ baseUrl: 'https://api.test', endpoints: [{ name: 'ep', method: 'GET', path }] });

describe('HttpConnector path templating', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fills {param} in path and query', async () => {
    const fn = mockFetch();
    await connector('/markets/{id}?limit={limit}').callTool('ep', { id: 'abc', limit: 5 });
    expect(fn.mock.calls[0][0]).toBe('https://api.test/markets/abc?limit=5');
  });

  it('drops query pairs whose {param} arg is missing', async () => {
    const fn = mockFetch();
    await connector('/markets?active={active}&limit={limit}&order=volume').callTool('ep', { limit: 10 });
    expect(fn.mock.calls[0][0]).toBe('https://api.test/markets?limit=10&order=volume');
  });

  it('drops the whole query string when every templated pair is missing', async () => {
    const fn = mockFetch();
    await connector('/markets?active={active}').callTool('ep', {});
    expect(fn.mock.calls[0][0]).toBe('https://api.test/markets');
  });
});
