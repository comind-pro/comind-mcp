import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';

// Embedded "zero-infra" mode: PGlite IS Postgres (WASM), so the same schema,
// migrations and pg-specific SQL run with no external database. Runs everywhere
// (in-memory) — unlike the db-guarded integration tests it needs no pg service.
describe('embedded PGlite (zero-infra mode)', () => {
  it('applies the Postgres migrations and runs pg-specific SQL', async () => {
    const client = new PGlite();
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });

    await client.query("insert into users (id,email,password_hash,created_at) values ('u','a@b.c','x',now())");
    await client.query(
      "insert into call_logs (id,owner_id,tool_name,status,source,duration_ms,created_at) values ('c','u','t','success','live',120,now())",
    );

    // The metrics endpoint relies on `filter`, `::int` casts and `percentile_cont`
    // — all Postgres-only. Confirm they execute under PGlite.
    const r = await db.execute(
      sql`select count(*) filter (where status='success')::int n,
                 coalesce(percentile_cont(0.95) within group (order by duration_ms),0)::int p95
          from call_logs`,
    );
    expect(r.rows[0]).toMatchObject({ n: 1, p95: 120 });
    await client.close();
  });
});
