import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';

describe('0016 projects migration', () => {
  it('creates default nodes and back-fills every resource', async () => {
    const client = new PGlite();
    const db = drizzle(client);
    const dir = resolve(process.cwd(), 'drizzle');
    // Run 0000–0015 from a copy whose journal stops there, seed pre-0016 rows, then
    // restore the full journal so the second migrate applies only 0016 to real data.
    const tmp = mkdtempSync(join(tmpdir(), 'mig-'));
    cpSync(dir, tmp, { recursive: true });
    const journalPath = join(tmp, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
    writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= 15) }));
    await migrate(db, { migrationsFolder: tmp });
    await client.exec(`
      INSERT INTO users (id, email, password_hash) VALUES ('u1', 'm@test.local', 'x');
      INSERT INTO sources (id, owner_id, name, kind, config) VALUES ('s1', 'u1', 'src', 'http', '{}');
      INSERT INTO tools (id, owner_id, kind, name) VALUES ('t1', 'u1', 'virtual', 'tool');
      INSERT INTO groups (id, owner_id, slug, name) VALUES ('g1', 'u1', 'grp', 'grp');
      INSERT INTO agents (id, owner_id, name) VALUES ('a1', 'u1', 'agent');
      INSERT INTO secrets (id, owner_id, name) VALUES ('k1', 'u1', 'KEY');
      INSERT INTO schedules (id, owner_id, group_id, cron, tool_name) VALUES ('c1', 'u1', 'g1', '* * * * *', 'tool');
      INSERT INTO call_logs (id, owner_id, tool_name, status, duration_ms) VALUES ('l1', 'u1', 'tool', 'success', 1);
    `);
    writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(db, { migrationsFolder: tmp });
    rmSync(tmp, { recursive: true, force: true });

    const nodes = await client.query<{ id: string; kind: string; parent_id: string | null; path: string }>(
      "select id, kind, parent_id, path from projects where owner_id = 'u1'",
    );
    expect(nodes.rows).toHaveLength(2);
    const team = nodes.rows.find((n) => n.kind === 'team');
    const proj = nodes.rows.find((n) => n.kind === 'project');
    expect(team?.parent_id).toBeNull();
    expect(team?.path).toBe(`/${team?.id}/`);
    expect(proj?.parent_id).toBe(team?.id);
    expect(proj?.path).toBe(`/${team?.id}/${proj?.id}/`);
    for (const t of ['sources', 'tools', 'groups', 'agents', 'secrets', 'schedules', 'call_logs']) {
      const r = await client.query<{ project_id: string }>(`select project_id from ${t}`);
      expect(
        r.rows.map((x) => x.project_id),
        t,
      ).toEqual([proj?.id]);
    }

    const sql = readFileSync(resolve(dir, '0016_projects.sql'), 'utf8');
    for (const t of ['sources', 'tools', 'groups', 'agents', 'secrets', 'schedules', 'call_logs']) {
      expect(sql).toMatch(new RegExp(`UPDATE "${t}" s SET "project_id"`));
      if (t !== 'call_logs')
        expect(sql).toMatch(new RegExp(`ALTER TABLE "${t}" ALTER COLUMN "project_id" SET NOT NULL`));
    }
    for (const [table, expected] of [
      ['project_access', 'NO'],
      ['sources', 'NO'],
      ['call_logs', 'YES'],
    ]) {
      const r = await client.query<{ is_nullable: string }>(
        "select is_nullable from information_schema.columns where table_name=$1 and column_name='project_id'",
        [table],
      );
      expect(r.rows[0]?.is_nullable, table).toBe(expected);
    }
    await client.close();
  });
});
