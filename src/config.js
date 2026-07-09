import 'dotenv/config';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 4000),
  store: process.env.STORE || 'memory', // 'memory' | 'mongo'
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/itsm_migrator',
  driver: process.env.DRIVER || 'mock', // 'mock' | 'live'
  batchSize: num(process.env.BATCH_SIZE, 100),
  zendesk: {
    subdomain: process.env.ZENDESK_SUBDOMAIN || '',
    email: process.env.ZENDESK_EMAIL || '',
    apiToken: process.env.ZENDESK_API_TOKEN || '',
    rpm: num(process.env.ZENDESK_RPM, 650),
    baseUrl: () => `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`,
  },
  freshdesk: {
    domain: process.env.FRESHDESK_DOMAIN || '',
    apiKey: process.env.FRESHDESK_API_KEY || '',
    rpm: num(process.env.FRESHDESK_RPM, 600),
    baseUrl: () => `https://${process.env.FRESHDESK_DOMAIN}.freshdesk.com/api/v2`,
  },
};
