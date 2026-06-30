import { config } from '../config.js';

/** fetch() with an AbortController timeout so a hung upstream can't hang the
 *  request/worker. Throws AbortError on timeout (connectors already catch). */
export async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  ms: number = config.upstreamTimeoutMs,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`Upstream timed out after ${ms}ms`)), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
