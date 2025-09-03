import { defineConfig } from 'drizzle-kit';

// Standalone (no app imports) so drizzle-kit's CJS loader can read it directly.
const url = process.env.DATABASE_URL ?? 'postgres://comind:comind@localhost:5432/comind';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url },
});
