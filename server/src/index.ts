import { buildApp } from './app.js';
import { config } from './config.js';
import { runMigrations } from './db/client.js';
import { initScheduler } from './scheduler/service.js';

async function main(): Promise<void> {
  await runMigrations();
  await initScheduler();

  const app = buildApp();
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`comind-mcp gateway up on http://${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
