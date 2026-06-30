import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import { config } from '../config.js';
import { schema } from './schema.js';

const url = config.databaseUrl;

// Two run modes — selected by the DATABASE_URL scheme, same schema & migrations:
//  - postgres://… / postgresql://…  → external Postgres (prod, multi-instance).
//  - file:<dir> / pglite:<dir> / memory:  → embedded Postgres (PGlite), zero-infra.
// PGlite IS Postgres (WASM), so the pg schema, migrations and raw SQL run unchanged.
export const embedded = /^(file:|pglite:|memory:)/.test(url);

// Managed Postgres (e.g. DigitalOcean) requires TLS. Enable SSL when the URL
// asks for it (`sslmode=require`) or DATABASE_SSL=true. We strip `sslmode` from
// the URL and drive TLS via the `ssl` object only: recent `pg` treats
// sslmode=require as verify-full, which overrides our ssl object and rejects the
// provider's self-signed CA. `rejectUnauthorized:false` accepts that CA; set
// DATABASE_CA to pin a real cert instead.
function sslConfig(u: string): { connectionString: string; ssl: pg.PoolConfig['ssl'] } {
  const wantSsl = /[?&]sslmode=(require|verify-ca|verify-full)/.test(u) || process.env.DATABASE_SSL === 'true';
  const connectionString = u.replace(/([?&])sslmode=[^&]*/, '$1').replace(/[?&]+$/, '');
  if (!wantSsl) return { connectionString, ssl: undefined };
  const ca = process.env.DATABASE_CA;
  return { connectionString, ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false } };
}

/** A minimal query interface common to pg.Pool and PGlite (used for health pings). */
export interface QueryClient {
  query(text: string): Promise<{ rows: unknown[] }>;
}

let dbInst: NodePgDatabase<typeof schema>;
let poolInst: QueryClient;
let migrateFn: (folder: string) => Promise<void>;

if (embedded) {
  // file:/abs/dir | file:///abs/dir | file:./rel → a directory path; memory: → in-memory.
  // (Strip the scheme, then collapse a leading // or /// authority to a single /,
  // so absolute paths keep their leading slash.)
  const dataDir = url.startsWith('memory:')
    ? 'memory://'
    : url
        .replace(/^(file:|pglite:)/, '')
        .replace(/^\/\/+/, '/')
        .trim();
  const client = new PGlite(dataDir);
  poolInst = client as unknown as QueryClient;
  dbInst = drizzlePglite(client, { schema }) as unknown as NodePgDatabase<typeof schema>;
  migrateFn = (folder) => migratePglite(dbInst as never, { migrationsFolder: folder });
} else {
  const p = new pg.Pool(sslConfig(url));
  poolInst = p as unknown as QueryClient;
  dbInst = drizzlePg(p, { schema });
  migrateFn = (folder) => migratePg(dbInst, { migrationsFolder: folder });
}

export const db = dbInst;
export const pool = poolInst;

/** Apply generated migrations on boot (so a fresh DB is ready without manual steps). */
export async function runMigrations(): Promise<void> {
  const dir = resolve(process.cwd(), 'drizzle');
  if (!existsSync(dir)) {
    throw new Error(`Migrations folder not found: ${dir}. Run \`pnpm db:generate\` first.`);
  }
  await migrateFn(dir);
}
