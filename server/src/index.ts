import { buildApp } from './app.js';
import { config } from './config.js';
import { pool, runMigrations } from './db/client.js';
import { initScheduler, stopScheduler } from './scheduler/service.js';

async function main(): Promise<void> {
  await runMigrations();
  await initScheduler();

  const app = buildApp();
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`comind-mcp gateway up on http://${config.host}:${config.port}`);

  // Graceful shutdown: stop cron, drain in-flight requests, close the DB.
  let closing = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info(`${sig} received — shutting down`);
    try {
      stopScheduler();
      await app.close(); // stops accepting + runs onClose hooks + drains in-flight
      await (pool as { end?: () => Promise<void> }).end?.();
    } catch (err) {
      app.log.error(err);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
