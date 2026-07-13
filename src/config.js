import 'dotenv/config';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

// Build the Mongo connection string from the environment.
//  • A full MONGODB_URI always wins (production / Atlas SRV) — set it and done.
//  • Otherwise assemble from parts, URL-encoding the password so special chars
//    (e.g. @) never break the URI.
// The ONLY thing that differs per environment is MONGO_HOST/MONGO_PORT:
//    local dev  → localhost:27018 (Docker Mongo's published port)
//    docker     → mongodb:27017   (in-network service name)
//    production → your managed host, or just set MONGODB_URI directly.
function buildMongoUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
  const enc = (v) => encodeURIComponent(v || '');
  const creds = process.env.MONGO_USERNAME ? `${enc(process.env.MONGO_USERNAME)}:${enc(process.env.MONGO_PASSWORD)}@` : '';
  const host = process.env.MONGO_HOST || 'localhost';
  const port = process.env.MONGO_PORT || '27017';
  const db = process.env.MONGO_DATABASE || 'itsm_migrator';
  return `mongodb://${creds}${host}:${port}/${db}${creds ? '?authSource=admin' : ''}`;
}

export const config = {
  port: num(process.env.PORT, 4400),
  store: process.env.STORE || 'mongo', // 'mongo' | 'memory' (memory for tests only)
  mongoUri: buildMongoUri(),
  oauthRedirectUri: process.env.OAUTH_REDIRECT_URI || 'http://localhost:5173/',
  batchSize: num(process.env.BATCH_SIZE, 100),
  // Parallel workers per object type at load time. The shared per-connector rate
  // limiter still caps total throughput, so this just keeps the pipe full up to
  // the API's rpm without 429 storms. Keep modest (5–10).
  concurrency: num(process.env.MIGRATION_CONCURRENCY, 6),
  zendesk: {
    subdomain: process.env.ZENDESK_SUBDOMAIN || '',
    email: process.env.ZENDESK_EMAIL || '',
    apiToken: process.env.ZENDESK_API_TOKEN || '',
    rpm: num(process.env.ZENDESK_RPM, 650),
  },
  freshdesk: {
    domain: process.env.FRESHDESK_DOMAIN || '',
    apiKey: process.env.FRESHDESK_API_KEY || '',
    rpm: num(process.env.FRESHDESK_RPM, 600),
  },
};
