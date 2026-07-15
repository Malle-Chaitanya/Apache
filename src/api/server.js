import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { initStore } from '../db/repository.js';
import { apiRouter } from './routes.js';
import { seedAppUsers } from '../auth/appAuth.js';
import { log } from '../lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Safety net: a migration runs in the background (the /run route fires
// runMigration and returns immediately), so an async error inside it would
// otherwise become an unhandledRejection/uncaughtException and kill the whole
// server process — interrupting the very migration in progress. Log the real
// error and stay up instead; the run is checkpointed and resumable.
process.on('unhandledRejection', (reason) => {
  log.error(`unhandledRejection: ${reason?.stack || reason}`);
});
process.on('uncaughtException', (err) => {
  log.error(`uncaughtException: ${err?.stack || err}`);
});

async function main() {
  await initStore();
  await seedAppUsers();
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', apiRouter());
  app.use(express.static(join(__dirname, '../../web/dist')));

  app.listen(config.port, () => {
    log.info(`ITSM Migrator running on http://localhost:${config.port}  (store=${config.store})`);
  });
}

main().catch((e) => { log.error(`fatal: ${e.message}`); process.exit(1); });
