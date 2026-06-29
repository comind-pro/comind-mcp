import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pool, runMigrations } from '../db/client.js';
import { tools, users, virtuals } from '../db/schema.js';
import { newId } from '../lib/id.js';
import { invokeTool } from './invoker.js';

/** Integration: invoker dispatch for virtual tools. Needs Postgres; skipped when
 *  unavailable. Executable cases use a blocked (private) target so no real HTTP. */
const dbUp = await pool
  .query('select 1')
  .then(() => true)
  .catch(() => false);

const tag = newId().slice(0, 6).toLowerCase();
const ownerId = newId();

async function makeVirtual(opts: {
  name: string;
  executable: boolean;
  request?: Record<string, unknown>;
  response?: unknown;
  readOnly?: boolean;
}) {
  const toolId = newId();
  await db.insert(tools).values({
    id: toolId, ownerId, sourceId: null, kind: 'virtual', name: opts.name,
    upstreamName: null, displayName: opts.name, description: 'd', inputSchema: {},
    readOnly: opts.readOnly ?? null, visible: true, createdAt: new Date(),
  });
  await db.insert(virtuals).values({ id: newId(), toolId, executable: opts.executable, request: opts.request ?? {}, response: opts.response ?? null });
  return opts.name;
}

const d = dbUp ? describe : describe.skip;

d('virtual tool invocation', () => {
  beforeAll(async () => {
    await runMigrations();
    await db.insert(users).values({ id: ownerId, email: `vt_${tag}@t.local`, passwordHash: 'x', createdAt: new Date() });
  });
  afterAll(async () => {
    await db.delete(users).where(inArray(users.id, [ownerId])); // cascades tools/virtuals
  });

  it('descriptive returns the static response body', async () => {
    const name = await makeVirtual({ name: `vt_${tag}_desc`, executable: false, response: { projects: [{ id: 1 }] } });
    const r = await invokeTool(name, {}, { ownerId });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ projects: [{ id: 1 }] });
  });

  it('descriptive with a plain-text response returns raw text', async () => {
    const name = await makeVirtual({ name: `vt_${tag}_txt`, executable: false, response: 'plain φ' });
    const r = await invokeTool(name, {}, { ownerId });
    expect(r.content[0].text).toBe('plain φ');
    expect(r.structuredContent).toBeUndefined();
  });

  it('descriptive without a response returns a catalog entry', async () => {
    const name = await makeVirtual({ name: `vt_${tag}_cat`, executable: false });
    const r = await invokeTool(name, {}, { ownerId });
    expect((r.structuredContent as { executable?: boolean }).executable).toBe(false);
  });

  it('executable to a private address is blocked (SSRF)', async () => {
    const name = await makeVirtual({ name: `vt_${tag}_ssrf`, executable: true, request: { method: 'GET', url: 'http://10.0.0.1:9/x' } });
    const r = await invokeTool(name, {}, { ownerId });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/private/i);
  });

  it('executable to this server itself is blocked', async () => {
    const name = await makeVirtual({ name: `vt_${tag}_self`, executable: true, request: { method: 'GET', url: 'http://localhost:8787/healthz' } });
    const r = await invokeTool(name, {}, { ownerId });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/this server/i);
  });

  it('read-only tool cannot use a mutating method', async () => {
    const name = await makeVirtual({ name: `vt_${tag}_ro`, executable: true, readOnly: true, request: { method: 'POST', url: 'https://example.com/x' } });
    const r = await invokeTool(name, {}, { ownerId });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/read-only/i);
  });
});
