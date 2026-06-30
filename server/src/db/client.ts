import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { config } from '../config.js';
import { schema } from './schema.js';

// Managed Postgres (e.g. DigitalOcean) requires TLS. Enable SSL when the URL
// asks for it (`sslmode=require`) or DATABASE_SSL=true. We strip `sslmode` from
// the URL and drive TLS via the `ssl` object only: recent `pg` treats
// sslmode=require as verify-full, which overrides our ssl object and rejects the
// provider's self-signed CA. `rejectUnauthorized:false` accepts that CA; set
// DATABASE_CA to pin a real cert instead.
function sslConfig(url: string): { connectionString: string; ssl: pg.PoolConfig['ssl'] } {
  const wantSsl = /[?&]sslmode=(require|verify-ca|verify-full)/.test(url) || process.env.DATABASE_SSL === 'true';
  const connectionString = url.replace(/([?&])sslmode=[^&]*/, '$1').replace(/[?&]+$/, '');
  if (!wantSsl) return { connectionString, ssl: undefined };
  const ca = process.env.DATABASE_CA;
  return { connectionString, ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false } };
}

export const pool = new pg.Pool(sslConfig(config.databaseUrl));

export const db = drizzle(pool, { schema });

/** Apply generated migrations on boot (so a fresh DB is ready without manual steps). */
export async function runMigrations(): Promise<void> {
  const dir = resolve(process.cwd(), 'drizzle');
  if (!existsSync(dir)) {
    throw new Error(`Migrations folder not found: ${dir}. Run \`pnpm db:generate\` first.`);
  }
  await migrate(db, { migrationsFolder: dir });
}
