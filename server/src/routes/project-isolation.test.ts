import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { db, pool, runMigrations } from '../db/client.js';
import { callLogs, groupTools, sources, tools, users } from '../db/schema.js';
import { newId } from '../lib/id.js';
import { invokeTool } from '../runtime/invoker.js';
import { loadSecretMap } from '../secrets/loader.js';

const dbUp = await pool
  .query('select 1')
  .then(() => true)
  .catch(() => false);

const app = buildApp();
const email = `iso-${Math.random().toString(36).slice(2, 8)}@test.local`;

type Row = { id: string; projectId: string; name: string; message?: string };

describe.skipIf(!dbUp)('project isolation: sources, tools, secrets', () => {
  let token: string;
  let ownerId: string;
  let A: string;
  let B: string;
  const srcA = { id: '' };
  const srcB = { id: '' };

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  const list = async (path: string, project?: string) =>
    (await call('GET', project ? `${path}?project=${project}` : path)).json() as Row[];
  const httpSource = (name: string, headers: Record<string, string> = {}) => ({
    name,
    kind: 'http',
    config: {
      baseUrl: 'http://127.0.0.1:9',
      headers,
      endpoints: [{ name: 'ping', method: 'GET', path: '/ping', description: 'ping' }],
    },
  });

  beforeAll(async () => {
    await runMigrations();
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'secret123' } });
    const reg = res.json() as { token: string; user: { id: string } };
    token = reg.token;
    ownerId = reg.user.id;
    const nodes = (await call('GET', '/projects')).json() as { id: string; kind: string; parentId: string | null }[];
    const root = nodes.find((n) => n.kind === 'team' && !n.parentId)?.id as string;
    const mk = async (name: string) =>
      ((await call('POST', '/projects', { kind: 'project', name, parentId: root })).json() as { id: string }).id;
    A = await mk('A');
    B = await mk('B');
    for (const [p, s, k] of [
      [A, srcA, 'AKEY'],
      [B, srcB, 'BKEY'],
    ] as const) {
      const r = await call('POST', `/sources?project=${p}`, httpSource(`src-${k}`));
      s.id = (r.json() as Row).id;
      await call('POST', `/sources/${s.id}/import?project=${p}`, {});
      await call('POST', `/secrets?project=${p}`, { name: k, value: `val-${k}` });
    }
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.email, email));
    await app.close();
  });

  it('lists are scoped: A sees only A, root sees both', async () => {
    for (const path of ['/sources', '/tools', '/secrets']) {
      const a = await list(path, A);
      expect(a.length).toBe(1);
      expect((await list(path)).length).toBe(2);
    }
  });

  it('reading B from A is 404', async () => {
    expect((await call('GET', `/sources/${srcB.id}?project=${A}`)).statusCode).toBe(404);
    expect((await call('PATCH', `/sources/${srcB.id}?project=${A}`, { name: 'x' })).statusCode).toBe(404);
    expect((await call('DELETE', `/sources/${srcB.id}?project=${A}`)).statusCode).toBe(404);
    const [toolB] = await list('/tools', B);
    expect((await call('GET', `/tools/${toolB.id}?project=${A}`)).statusCode).toBe(404);
    expect((await call('DELETE', `/tools/${toolB.id}?project=${A}`)).statusCode).toBe(404);
    expect((await call('GET', `/sources/${srcB.id}`)).statusCode).toBe(200); // still there
    const [secB] = await list('/secrets', B);
    expect((await call('DELETE', `/secrets/${secB.id}?project=${A}`)).statusCode).toBe(404);
    expect((await list('/secrets')).map((x) => x.id)).toContain(secB.id);
  });

  it('a granted source is readable but not editable from A', async () => {
    const g = await call('POST', `/projects/${A}/access`, { resourceType: 'source', resourceId: srcB.id });
    expect(g.statusCode).toBe(201);
    expect((await call('GET', `/sources/${srcB.id}?project=${A}`)).statusCode).toBe(200);
    expect((await list('/tools', A)).map((t) => t.name)).toContain('src-bkey.ping');
    expect((await call('PATCH', `/sources/${srcB.id}?project=${A}`, { name: 'x' })).statusCode).toBe(404);
    expect((await call('DELETE', `/sources/${srcB.id}?project=${A}`)).statusCode).toBe(404);
  });

  it("A's source cannot resolve B's secret by name", async () => {
    const mapA = await loadSecretMap(ownerId, undefined, A);
    expect(mapA.AKEY).toBe('val-AKEY'); // positive control
    expect(mapA).not.toHaveProperty('BKEY');
    const r = await call('POST', `/sources?project=${A}`, httpSource('own', { 'x-k': '${secret.AKEY}' }));
    const t = (await call('POST', `/sources/${(r.json() as Row).id}/test?project=${A}`)).json() as { message: string };
    expect(t.message).not.toContain('pending');
  });

  it('a pending secret fails loudly', async () => {
    const s = await call('POST', `/secrets?project=${A}`, { name: 'PK', pending: true });
    expect(s.statusCode).toBe(201);
    expect((s.json() as { pending: boolean }).pending).toBe(true);
    const r = await call('POST', '/sources?project=' + A, httpSource('pend', { 'x-k': '${secret.PK}' }));
    const id = (r.json() as Row).id;
    const t = (await call('POST', `/sources/${id}/test?project=${A}`)).json() as { ok: boolean; message: string };
    expect(t.message).toContain('secret PK is pending — set its value in admin');
  });

  it('new rows land in ?project= or the default project', async () => {
    const a = (await call('POST', `/sources?project=${A}`, httpSource('inA'))).json() as Row;
    expect(a.projectId).toBe(A);
    const d = (await call('POST', '/sources', httpSource('inDefault'))).json() as Row;
    const nodes = (await call('GET', '/projects')).json() as { id: string; kind: string; slug: string }[];
    expect(d.projectId).toBe(nodes.find((n) => n.kind === 'project' && n.slug === 'default')?.id);
  });

  const mkGroup = async (p: string, name: string) =>
    ((await call('POST', `/groups?project=${p}`, { name })).json() as Row).id;
  const mkAgent = async (p: string, name: string) =>
    ((await call('POST', `/agents?project=${p}`, { name })).json() as Row).id;

  it('a workspace in A refuses an ungranted B tool and accepts it once granted', async () => {
    const sB = ((await call('POST', `/sources?project=${B}`, httpSource('fresh-b'))).json() as Row).id;
    await call('POST', `/sources/${sB}/import?project=${B}`, {});
    const bTool = (await list('/tools', B)).find((t) => t.name === 'fresh-b.ping') as Row;
    const gA = await mkGroup(A, 'gA-tools');
    const put = () => call('PUT', `/groups/${gA}/tools?project=${A}`, { toolIds: [bTool.id] });
    const r = await put();
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: string }).error).toBe('unknown_tools');
    await call('POST', `/projects/${A}/access`, { resourceType: 'source', resourceId: sB });
    expect((await put()).statusCode).toBe(200);
  });

  it('groups/agents in B are invisible from A', async () => {
    const gB = await mkGroup(B, 'gB');
    const aB = await mkAgent(B, 'aB');
    expect((await list('/groups', A)).map((g) => g.id)).not.toContain(gB);
    expect((await list('/groups')).map((g) => g.id)).toContain(gB);
    expect((await list('/agents', A)).map((g) => g.id)).not.toContain(aB);
    expect((await call('GET', `/groups/${gB}?project=${A}`)).statusCode).toBe(404);
    expect((await call('DELETE', `/groups/${gB}?project=${A}`)).statusCode).toBe(404);
    expect((await list('/groups')).map((g) => g.id)).toContain(gB);
    expect((await call('GET', `/agents/${aB}?project=${A}`)).statusCode).toBe(404);
    expect(
      (await call('POST', `/groups/${gB}/schedules?project=${A}`, { cron: '* * * * *', toolName: 'x' })).statusCode,
    ).toBe(404);
  });

  it('an agent in A cannot be granted a group in B', async () => {
    const aA = await mkAgent(A, 'aA');
    const gB = await mkGroup(B, 'gB2');
    const r = await call('POST', `/agents/${aA}/groups?project=${A}`, { groupId: gB });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: string }).error).toBe('unknown_group');
  });

  it('call logs carry the tool project and filter by it', async () => {
    const tA = (await list('/tools', A)).find((t) => t.name === 'src-akey.ping') as Row;
    await call('POST', `/tools/${tA.id}/test?project=${A}`, {});
    const logs = async (p: string) =>
      ((await call('GET', `/logs?project=${p}`)).json() as { toolName: string }[]).map((l) => l.toolName);
    for (let i = 0; i < 40 && !(await logs(A)).includes('src-akey.ping'); i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(await logs(A)).toContain('src-akey.ping');
    expect(await logs(B)).not.toContain('src-akey.ping');
  });

  it('bundle import cannot reuse invisible rows; works after a grant', async () => {
    const sB = ((await call('POST', `/sources?project=${B}`, httpSource('bundle-src'))).json() as Row).id;
    await call('POST', `/sources/${sB}/import?project=${B}`, {});
    const gB = await mkGroup(B, 'bundle-grp');
    const bt = (await list('/tools', B)).find((t) => t.name === 'bundle-src.ping') as Row;
    await call('PUT', `/groups/${gB}/tools?project=${B}`, { toolIds: [bt.id] });
    const bundle = (await call('GET', `/groups/${gB}/export?project=${B}`)).json();
    const imp = () =>
      app.inject({
        method: 'POST',
        url: `/groups/import?project=${A}`,
        payload: bundle,
        headers: { authorization: `Bearer ${token}` },
      });
    const r1 = await imp();
    expect(r1.statusCode).toBe(409);
    expect((r1.json() as { error: string }).error).toBe('name_taken');
    await call('POST', `/projects/${A}/access`, { resourceType: 'source', resourceId: sB });
    // group slug still taken by B's invisible group -> remove it from the bundle
    const b2 = {
      ...(bundle as { group: { slug: string } }),
      group: { ...(bundle as { group: object }).group, slug: 'bundle-grp-a' },
    };
    const r2 = await app.inject({
      method: 'POST',
      url: `/groups/import?project=${A}`,
      payload: b2,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r2.statusCode).toBe(201);
    const rep = r2.json() as { sources: { skipped: string[] } };
    expect(rep.sources.skipped).toContain('bundle-src');
    const g = (await list('/groups', A)).find((x) => x.name === 'bundle-grp');
    expect(g?.projectId).toBe(A);
  });

  const err = (r: { json: () => unknown }) => r.json() as { error: string; names?: string[]; missing?: string[] };

  it('C1: a second source with the same slug is refused, and import never re-points a foreign tool', async () => {
    const d = (await call('POST', `/sources?project=${A}`, httpSource('dupe'))).json() as Row;
    await call('POST', `/sources/${d.id}/import?project=${A}`, {});
    const r = await call('POST', `/sources?project=${B}`, httpSource('dupe'));
    expect(r.statusCode).toBe(409);
    expect(err(r).error).toBe('name_taken');
    const d2 = (await call('POST', `/sources?project=${B}`, httpSource('dupe2'))).json() as Row;
    const p = await call('PATCH', `/sources/${d2.id}?project=${B}`, { name: 'Dupe' }); // same slug
    expect(p.statusCode).toBe(409);
    expect(err(p).error).toBe('name_taken');
    expect((await call('PATCH', `/sources/${d2.id}?project=${B}`, { name: 'dupe2' })).statusCode).toBe(200);
    // legacy data: a same-slug source that slipped in before the guard
    const legacy = newId();
    await db.insert(sources).values({
      id: legacy,
      ownerId,
      projectId: B,
      name: 'dupe',
      kind: 'http',
      config: httpSource('dupe').config,
      status: 'unknown',
      createdAt: new Date(),
    });
    const imp = await call('POST', `/sources/${legacy}/import?project=${B}`, { force: true });
    expect(imp.statusCode).toBe(409);
    expect(err(imp).names).toEqual(['dupe.ping']);
    const [t] = await db
      .select()
      .from(tools)
      .where(and(eq(tools.ownerId, ownerId), eq(tools.name, 'dupe.ping')));
    expect(t.sourceId).toBe(d.id);
    expect(t.projectId).toBe(A);
  });

  it("I1: bundle import into B's group refuses A's ungranted tool (root scope)", async () => {
    const gB = await mkGroup(B, 'i1-grp');
    const { slug } = (await call('GET', `/groups/${gB}`)).json() as { slug: string };
    const before = await db.select().from(groupTools).where(eq(groupTools.groupId, gB));
    const r = await call('POST', '/groups/import', {
      version: 1,
      group: { slug, name: 'i1' },
      sources: [httpSource('src-AKEY')],
      tools: [{ name: 'src-akey.ping', kind: 'native', source: 'src-AKEY', upstreamName: 'ping' }],
      secrets: [],
    });
    expect(r.statusCode).toBe(400);
    expect(err(r).error).toBe('unknown_tools');
    expect(err(r).missing).toEqual(['src-akey.ping']);
    expect(await db.select().from(groupTools).where(eq(groupTools.groupId, gB))).toEqual(before);
  });

  it("bundle import into B's group refuses reusing A's ungranted source (root scope)", async () => {
    const gB = await mkGroup(B, 'srcuse-grp');
    const { slug } = (await call('GET', `/groups/${gB}`)).json() as { slug: string };
    const r = await call('POST', '/groups/import', {
      version: 1,
      group: { slug, name: 'srcuse' },
      sources: [httpSource('src-AKEY')],
      tools: [],
      secrets: [],
    });
    expect(r.statusCode).toBe(400);
    expect(err(r).error).toBe('unknown_sources');
    expect(err(r).missing).toEqual(['src-AKEY']);
  });

  it('bundle-created sources go through the source slug check', async () => {
    await call('POST', `/sources?project=${B}`, httpSource('slug-clash'));
    const r = await call('POST', `/groups/import?project=${A}`, {
      version: 1,
      group: { slug: 'slug-clash-grp', name: 'slug-clash-grp' },
      sources: [httpSource('Slug Clash')],
      tools: [],
      secrets: [],
    });
    expect(r.statusCode).toBe(409);
    expect(err(r).names).toEqual(['Slug Clash']);
  });

  it("I2: a source-scoped secret created at root lives in the source's project", async () => {
    const r = await call('POST', '/secrets', { name: 'SRCB', value: 'val-SRCB', sourceId: srcB.id });
    expect(r.statusCode).toBe(201);
    expect((r.json() as Row).projectId).toBe(B);
    expect((await loadSecretMap(ownerId, srcB.id, B)).SRCB).toBe('val-SRCB');
  });

  it("I3: a virtual tool in A cannot resolve B's secret", async () => {
    // The secret sits in the URL scheme, so the runtime's error text shows what it resolved to.
    const run = async (name: string, key: string) => {
      const v = await call('POST', `/virtual-tools?project=${A}`, {
        name,
        request: { method: 'GET', url: `\${secret.${key}}://x` },
      });
      expect(v.statusCode).toBe(201);
      const res = (await call('POST', `/tools/${(v.json() as Row).id}/test?project=${A}`, {})).json() as {
        content: { text: string }[];
      };
      return res.content.map((c) => c.text).join(' ');
    };
    expect(await run('vt-own', 'AKEY')).toContain('val-akey'); // positive control
    expect(await run('vt-leak', 'BKEY')).not.toContain('val-bkey');
  });

  it("I4: logs carry the caller group's project; root sees unattributed rows", async () => {
    const gB = await mkGroup(B, 'i4-grp');
    await invokeTool('src-akey.ping', {}, { ownerId, groupId: gB, agentId: null, source: 'test' });
    await invokeTool('nope-i4', {}, { ownerId, groupId: null, agentId: null, source: 'test' });
    const rows = async () =>
      (await call('GET', '/logs')).json() as { toolName: string; groupId: string | null; projectId: string | null }[];
    for (let i = 0; i < 40 && !(await rows()).some((l) => l.toolName === 'nope-i4'); i++)
      await new Promise((r) => setTimeout(r, 50));
    const all = await rows();
    expect(all.find((l) => l.toolName === 'nope-i4')?.projectId).toBeNull();
    expect(all.find((l) => l.groupId === gB)?.projectId).toBe(B);
    const inA = (await call('GET', `/logs?project=${A}`)).json() as { toolName: string }[];
    expect(inA.map((l) => l.toolName)).not.toContain('nope-i4');
    const m = (await call('GET', '/metrics')).json() as { byTool: { tool_name: string }[] };
    expect(m.byTool.map((t) => t.tool_name)).toContain('nope-i4');
    await db.delete(callLogs).where(eq(callLogs.toolName, 'nope-i4'));
  });

  it("I5: PATCH checks composite refs against the composite's project", async () => {
    const step = (tool: string) => ({ definition: { steps: [{ id: 's1', tool }] } });
    const c = await call('POST', `/composite-tools?project=${B}`, { name: 'comp-b', ...step('src-bkey.ping') });
    expect(c.statusCode).toBe(201);
    const id = (c.json() as Row).id;
    expect((await call('PATCH', `/composite-tools/${id}`, step('src-bkey.ping'))).statusCode).toBe(200);
    const bad = await call('PATCH', `/composite-tools/${id}`, step('src-akey.ping'));
    expect(bad.statusCode).toBe(400);
    expect(err(bad).error).toBe('unknown_tools');
  });

  it('a grantee can test a source but does not write its status', async () => {
    await db.update(sources).set({ status: 'unknown' }).where(eq(sources.id, srcB.id)); // granted to A earlier
    expect((await call('POST', `/sources/${srcB.id}/test?project=${A}`)).statusCode).toBe(200);
    const [row] = await db.select().from(sources).where(eq(sources.id, srcB.id));
    expect(row.status).toBe('unknown');
    await call('POST', `/sources/${srcB.id}/test?project=${B}`);
    expect((await db.select().from(sources).where(eq(sources.id, srcB.id)))[0].status).not.toBe('unknown');
  });

  it("OAuth start is 404 for a source outside the caller's subtree", async () => {
    expect((await call('GET', `/sources/${srcB.id}/oauth/start?project=${A}`)).statusCode).toBe(404);
    expect((await call('GET', `/sources/${srcB.id}/oauth/start?project=${B}`)).statusCode).toBe(400); // no oauth
  });
});
