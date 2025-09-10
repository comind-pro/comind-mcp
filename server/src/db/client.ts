import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { config } from '../config.js';
import { schema } from './schema.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export const db = drizzle(pool, { schema });

/** Apply generated migrations on boot (so a fresh DB is ready without manual steps). */
export async function runMigrations(): Promise<void> {
  const dir = resolve(process.cwd(), 'drizzle');
  if (!existsSync(dir)) {
    throw new Error(`Migrations folder not found: ${dir}. Run \`pnpm db:generate\` first.`);
  }
  await migrate(db, { migrationsFolder: dir });
}
