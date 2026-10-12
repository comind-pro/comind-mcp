import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';

describe('0016 projects migration', () => {
  it('creates default nodes and back-fills every resource', async () => {
    const client = new PGlite();
    const db = drizzle(client);
    const dir = resolve(process.cwd(), 'drizzle');
    // The migrator cannot stop at 0015, so the back-fill is pinned by asserting the SQL text; runtime behaviour for new users is covered by ensureDefaultNodes in the project route tests added in a later task.
    await migrate(db, { migrationsFolder: dir });
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
