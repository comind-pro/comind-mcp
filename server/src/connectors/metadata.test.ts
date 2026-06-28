import { describe, expect, it } from 'vitest';
import { GaConnector } from './ga.js';
import { ImapSmtpConnector } from './imap.js';
import { SqlConnector } from './sql.js';

// listTools() is static (no network/db) for these connectors, so we can assert
// the curated discovery metadata they emit at import time.

describe('SQL connector curated metadata', () => {
  it('every tool is read-only with output schema and examples', async () => {
    const tools = await new SqlConnector({ url: 'postgres://x/y' }).listTools();
    for (const t of tools) {
      expect(t.readOnly, t.name).toBe(true);
      expect(t.permissions, t.name).toContain('db.read');
      expect((t.outputSchema as { properties?: { rows?: unknown } })?.properties?.rows, t.name).toBeDefined();
      expect(t.examples?.length, t.name).toBeGreaterThan(0);
    }
  });
});

describe('GA connector curated metadata', () => {
  const tools = () => new GaConnector({ sa: '{}' }).listTools();

  it('run_report has correct-format example + report output schema', async () => {
    const rr = (await tools()).find((t) => t.name === 'run_report')!;
    expect(rr.readOnly).toBe(true);
    expect(rr.permissions).toContain('ga4.read');
    expect(Array.isArray(rr.examples?.[0].input.dimensions)).toBe(true); // arrays, not {name:...}
    expect(Array.isArray(rr.examples?.[0].input.metrics)).toBe(true);
    expect((rr.outputSchema as { properties?: { rows?: unknown } })?.properties?.rows).toBeDefined();
  });

  it('all GA tools carry an output schema', async () => {
    for (const t of await tools()) {
      expect(t.outputSchema, t.name).toBeDefined();
    }
  });
});

describe('IMAP connector curated metadata', () => {
  it('reads are safe, send is dangerous + needs confirmation', async () => {
    const tools = await new ImapSmtpConnector({
      imap: { host: 'h', port: 993, secure: true, user: 'u', pass: 'p' },
      smtp: { host: 'h', port: 587, secure: false, user: 'u', pass: 'p' },
    } as never).listTools();
    const get = (n: string) => tools.find((t) => t.name === n)!;
    expect(get('get_message').readOnly).toBe(true);
    expect(get('list_messages').permissions).toContain('mail.read');
    expect(get('send_message').dangerous).toBe(true);
    expect(get('send_message').recommendedUse?.requires_user_confirmation).toBe(true);
  });
});
