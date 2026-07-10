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
