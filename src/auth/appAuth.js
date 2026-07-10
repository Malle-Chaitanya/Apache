import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { repo } from '../db/repository.js';
import { log } from '../lib/logger.js';

// ─────────────────────────────────────────────────────────────
// Layer-1 portal authentication (the appUsers accounts).
// Provisioned by us; clients sign in with the credentials we give them.
// bcrypt-hashed passwords, JWT session tokens.
// ─────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-change-me';
const TOKEN_TTL = '12h';
const norm = (e) => (e || '').trim().toLowerCase();
const safeUser = (u) => ({ id: String(u._id), email: u.email, name: u.name, role: u.role });

// Seed 3 default accounts on first boot if the collection is empty.
export async function seedAppUsers() {
  if (await repo('appUsers').count({})) return;
  const defaults = [
    { email: 'admin@cloudfuze.com', pw: 'CloudFuze@2026', name: 'Admin User', role: 'admin' },
  ];
  for (const d of defaults) {
    await repo('appUsers').insertOne({ email: d.email, password: await bcrypt.hash(d.pw, 10), name: d.name, role: d.role });
  }
  log.info(`seeded ${defaults.length} portal accounts (appUsers)`);
}

export async function login(email, password) {
  const user = await repo('appUsers').findOne({ email: norm(email) });
  if (!user || !user.password) throw new AuthError('invalid email or password');
  if (!(await bcrypt.compare(password || '', user.password))) throw new AuthError('invalid email or password');
  const token = jwt.sign({ sub: String(user._id), email: user.email, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  return { token, user: safeUser(user) };
}

export async function userFromToken(token) {
  const payload = jwt.verify(token, JWT_SECRET); // throws if invalid/expired
  const user = await repo('appUsers').findOne({ _id: payload.sub });
  if (!user) throw new AuthError('account no longer exists');
  return safeUser(user);
}

// Express middleware — protects everything mounted after it.
export function requireAuth() {
  return async (req, res, next) => {
    try {
      const h = req.headers.authorization || '';
      const token = h.startsWith('Bearer ') ? h.slice(7) : null;
      if (!token) return res.status(401).json({ error: 'authentication required' });
      req.appUser = await userFromToken(token);
      req.appUserId = req.appUser.id;
      next();
    } catch {
      res.status(401).json({ error: 'invalid or expired session' });
    }
  };
}

export class AuthError extends Error {}
