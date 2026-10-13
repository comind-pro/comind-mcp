import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { db, pool, runMigrations } from '../db/client.js';
import { agentKeys, sources, userFeatures, users } from '../db/schema.js';
import { PYTHON_TOOLS } from '../lib/features.js';
import { newId } from '../lib/id.js';
import { type Scope, scopeForOwner } from '../lib/scope.js';
import { createAgent, revokeAgent, setAgentRole } from './agents.js';
import { addGroupTool, createGroup, listGroupTools, setGroupTools } from './groups.js';
import { createNode } from './projects.js';
import { declareSecret, listSecrets } from './secrets.js';
import {
  createSource,
  getSource,
  importSource,
  isErr,
  listSources,
  previewImportRemovals,
  refreshObjects,
  type SourceRow,
  testSource,
} from './sources.js';
import { createCompositeTool, createPythonTool, createVirtualTool, getTool, listTools, testTool } from './tools.js';

const dbUp = await pool
  .query('select 1')
  .then(() => true)
  .catch(() => false);

const app = buildApp();
const email = `svc-${Math.random().toString(36).slice(2, 8)}@test.local`;
const NF = { error: 'not_found' };

const httpCfg = (endpoints = ['ping']) => ({
  baseUrl: 'http://127.0.0.1:9',
  headers: {},
  endpoints: endpoints.map((name) => ({ name, method: 'GET', path: `/${name}`, description: name })),
});

describe.skipIf(!dbUp)('scoped services', () => {
  let ownerId: string;
  let A: Scope;
  let B: Scope;
  let srcA: SourceRow;
  let srcB: SourceRow;

  beforeAll(async () => {
    await runMigrations();
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'secret123' } });
    ownerId = (res.json() as { user: { id: string } }).user.id;
    const root = (await scopeForOwner(ownerId)) as Scope;
    const mk = async (name: string) => {
      const n = await createNode(root, { kind: 'project', name, parentId: root.nodeId });
      if (n === 'not_found') throw new Error('no node');
      return (await scopeForOwner(ownerId, n.id)) as Scope;
    };
    A = await mk('svc-a');
    B = await mk('svc-b');
    srcA = (await createSource(A, { name: 'svc-src-a', kind: 'http', config: httpCfg() }, null)) as SourceRow;
    srcB = (await createSource(B, { name: 'svc-src-b', kind: 'http', config: httpCfg() }, null)) as SourceRow;
    await importSource(A, srcA.id, { force: false, createdByAgentId: null });
    await importSource(B, srcB.id, { force: false, createdByAgentId: null });
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.email, email));
    await app.close();
  });

  const toolOf = async (scope: Scope, name: string) => (await listTools(scope)).find((t) => t.name === name)!;

  it('isErr', () => {
    expect(isErr({ error: 'not_found' })).toBe(true);
    expect(isErr({ id: 'x' })).toBe(false);
    expect(isErr(null)).toBe(false);
  });

  it('createSource: lands in createIn; same slug → name_taken', async () => {
    expect(srcA.projectId).toBe(A.nodeId);
    expect(await createSource(B, { name: 'SVC-SRC-A', kind: 'http', config: httpCfg() }, null)).toEqual({
      error: 'name_taken',
    });
  });

  it('listSources / getSource are scoped', async () => {
    expect((await listSources(A)).map((s) => s.id)).toEqual([srcA.id]);
    expect(((await getSource(A, srcA.id)) as SourceRow).id).toBe(srcA.id);
    expect(await getSource(A, srcB.id)).toEqual(NF);
  });

  it('testSource: visible only', async () => {
    const r = await testSource(A, srcA.id);
    expect(isErr(r)).toBe(false);
    expect((r as { ok: boolean }).ok).toBe(false); // 127.0.0.1:9 refuses
    expect(await testSource(A, srcB.id)).toEqual(NF);
  });

  it('refreshObjects: administered only', async () => {
    const r = await refreshObjects(A, srcA.id);
    expect((r as { objects: unknown[] }).objects).toEqual([]);
    expect(await refreshObjects(A, srcB.id)).toEqual(NF);
  });

  it('importSource: report; foreign → not_found', async () => {
    const r = await importSource(A, srcA.id, { force: false, createdByAgentId: null });
    expect(r).toMatchObject({ mode: 'new', total: 1, created: 0, skipped: 1, imported: 1 });
    expect(await importSource(A, srcB.id, { force: false, createdByAgentId: null })).toEqual(NF);
  });

  it('previewImportRemovals: lists what force would remove, writes nothing', async () => {
    const s = (await createSource(
      A,
      { name: 'svc-prev', kind: 'http', config: httpCfg(['a', 'b']) },
      null,
    )) as SourceRow;
    await importSource(A, s.id, { force: false, createdByAgentId: null });
    await db
      .update(sources)
      .set({ config: httpCfg(['a']) })
      .where(eq(sources.id, s.id));
    expect(await previewImportRemovals(A, s.id)).toEqual({ removed: ['svc-prev.b'] });
    expect((await listTools(A, { sourceId: s.id })).length).toBe(2);
    expect(await previewImportRemovals(A, srcB.id)).toEqual(NF);
  });

  it('listTools / getTool are scoped', async () => {
    const tA = await toolOf(A, 'svc-src-a.ping');
    const tB = await toolOf(B, 'svc-src-b.ping');
    expect((await listTools(A, { kind: 'native' })).map((t) => t.name)).not.toContain('svc-src-b.ping');
    expect((await getTool(A, tA.id)) as { id: string }).toMatchObject({ id: tA.id });
    expect(await getTool(A, tB.id)).toEqual(NF);
  });

  it('createVirtualTool + testTool', async () => {
    const v = await createVirtualTool(A, { name: 'svc-v', executable: false, response: { hi: 1 } }, 'agentX');
    expect(v).toMatchObject({ kind: 'virtual', projectId: A.nodeId, createdByAgentId: 'agentX' });
    const r = await testTool(A, (v as { id: string }).id, {}, { agentId: null });
    expect(JSON.stringify(r)).toContain('hi');
    expect(await testTool(B, (v as { id: string }).id, {}, { agentId: null })).toEqual(NF);
    expect(await createVirtualTool(A, { name: 'svc-v', executable: false }, null)).toEqual({ error: 'name_taken' });
  });

  it('createCompositeTool: refs checked against createIn', async () => {
    const def = (tool: string) => ({ steps: [{ id: 's1', tool }] });
    const ok = await createCompositeTool(A, { name: 'svc-c', definition: def('svc-src-a.ping') }, null);
    expect(ok).toMatchObject({ kind: 'composite', projectId: A.nodeId });
    expect(await createCompositeTool(A, { name: 'svc-c2', definition: def('svc-src-b.ping') }, null)).toEqual({
      error: 'unknown_tools',
      detail: { missing: ['svc-src-b.ping'] },
    });
  });

  it('createPythonTool: feature gate', async () => {
    const input = { name: 'svc-py', code: 'def main(args):\n  return 1' };
    expect(await createPythonTool(A, input, null)).toMatchObject({ error: 'feature_disabled' });
    await db.insert(userFeatures).values({ id: newId(), userId: ownerId, feature: PYTHON_TOOLS, enabled: true });
    expect(await createPythonTool(A, input, null)).toMatchObject({ kind: 'python', projectId: A.nodeId });
  });

  it('groups: create / setGroupTools / addGroupTool / listGroupTools', async () => {
    const tA = await toolOf(A, 'svc-src-a.ping');
    const tB = await toolOf(B, 'svc-src-b.ping');
    const g = await createGroup(A, { name: 'svc-g' }, 'agentX');
    expect(g).toMatchObject({ projectId: A.nodeId, createdByAgentId: 'agentX', slug: 'svc-g' });
    expect(await setGroupTools(A, g.id, [tA.id])).toEqual({ groupId: g.id, toolIds: [tA.id] });
    expect(await setGroupTools(A, g.id, [tB.id])).toEqual({ error: 'unknown_tools', detail: { missing: [tB.id] } });
    expect(await setGroupTools(B, g.id, [])).toEqual(NF);
    const v = (await createVirtualTool(A, { name: 'svc-v2', executable: false }, null)) as { id: string };
    expect(await addGroupTool(A, g.id, v.id)).toEqual({ groupId: g.id, toolIds: [tA.id, v.id] });
    expect(await addGroupTool(A, g.id, tB.id)).toEqual({ error: 'unknown_tools', detail: { missing: [tB.id] } });
    expect(await addGroupTool(B, g.id, v.id)).toEqual(NF);
    expect(((await listGroupTools(A, g.id)) as { id: string }[]).map((t) => t.id).sort()).toEqual([tA.id, v.id].sort());
    expect(await listGroupTools(B, g.id)).toEqual(NF);
  });

  it('agents: create / setAgentRole / revokeAgent', async () => {
    const g = await createGroup(A, { name: 'svc-ag' }, null);
    const gB = await createGroup(B, { name: 'svc-ag-b' }, null);
    const r = await createAgent(A, { name: 'svc-agent', role: 'lead', groupIds: [g.id] }, 'agentX');
    if (isErr(r)) throw new Error(JSON.stringify(r));
    expect(r.agent).toMatchObject({ projectId: A.nodeId, role: 'lead', createdByAgentId: 'agentX' });
    expect(r.apiKey).toBeTruthy();
    expect(r.endpoints.agent).toMatch(/\/a\/mcp$/);
    expect(r.endpoints.groups).toEqual([{ id: g.id, slug: g.slug, url: expect.stringMatching(`/g/${g.id}/mcp$`) }]);
    expect(await createAgent(A, { name: 'x', role: 'lead', projectId: B.nodeId, groupIds: [] }, null)).toEqual(NF);
    expect(await createAgent(A, { name: 'x', role: 'lead', groupIds: [gB.id] }, null)).toEqual(NF);

    expect(await setAgentRole(A, r.agent.id, 'coo')).toMatchObject({ role: 'coo' });
    expect(await setAgentRole(B, r.agent.id, 'lead')).toEqual(NF);

    expect(await revokeAgent(B, r.agent.id)).toEqual(NF);
    expect(await revokeAgent(A, r.agent.id)).toEqual({ archivedKeys: 1 });
    const keys = await db.select().from(agentKeys).where(eq(agentKeys.agentId, r.agent.id));
    expect(keys.every((k) => k.archived)).toBe(true);
  });

  it('secrets: declareSecret (pending, lives with source) / listSecrets', async () => {
    const s = await declareSecret(A, { name: 'SVC_PEND' }, 'agentX');
    expect(s).toMatchObject({ name: 'SVC_PEND', pending: true, projectId: A.nodeId, createdByAgentId: 'agentX' });
    const root = (await scopeForOwner(ownerId)) as Scope;
    expect(await declareSecret(root, { name: 'SVC_SRC', sourceId: srcB.id }, null)).toMatchObject({
      projectId: B.nodeId,
    });
    expect(await declareSecret(A, { name: 'SVC_X', sourceId: srcB.id }, null)).toEqual(NF);
    const names = (await listSecrets(A)).map((x) => x.name);
    expect(names).toContain('SVC_PEND');
    expect(names).not.toContain('SVC_SRC');
    expect(JSON.stringify(await listSecrets(A))).not.toContain('encryptedValue');
  });
});
