import crypto from 'node:crypto';
import { ADMIN_USERNAME, ADMIN_PASSWORD, SESSION_SECRET, SESSION_HOURS, TRUST_PROXY } from './config.js';

export const COOKIE_NAME = 'mh_admin';
const secret = SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!SESSION_SECRET) console.warn('[auth] SESSION_SECRET not set: admin sessions will reset whenever the server restarts.');
if (!ADMIN_PASSWORD) console.warn('[auth] ADMIN_PASSWORD not set: admin login is disabled.');

export const adminEnabled = () => Boolean(ADMIN_PASSWORD);

function sign(payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function createToken() {
  const payload = Buffer.from(JSON.stringify({ u: ADMIN_USERNAME, exp: Date.now() + SESSION_HOURS * 3600 * 1000, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return false;
  const payload = token.slice(0, dot); const sig = token.slice(dot + 1);
  if (!safeEqual(sig, sign(payload))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.u === ADMIN_USERNAME && typeof data.exp === 'number' && data.exp > Date.now();
  } catch { return false; }
}

export function checkCredentials(username, password) {
  if (!adminEnabled()) return false;
  // Compare both so that timing does not leak which part was wrong.
  const userOk = safeEqual(String(username ?? ''), ADMIN_USERNAME);
  const passOk = safeEqual(String(password ?? ''), ADMIN_PASSWORD);
  return userOk && passOk;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Express middleware: sets req.isAdmin. */
export function attachAdmin(req, _res, next) {
  const cookies = parseCookies(req.headers.cookie);
  req.isAdmin = verifyToken(cookies[COOKIE_NAME]);
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.isAdmin) return res.status(401).json({ error: 'Admin login required.' });
  next();
}

export function cookieOptions(req) {
  const secure = TRUST_PROXY ? req.headers['x-forwarded-proto'] === 'https' : req.secure;
  return { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: SESSION_HOURS * 3600 * 1000 };
}

// Simple in-memory login throttle: 10 failed attempts per IP per 15 minutes.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000; const MAX_ATTEMPTS = 10;
export function loginThrottle(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const rec = attempts.get(ip);
  if (rec && now - rec.first < WINDOW_MS && rec.count >= MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in a few minutes.' });
  }
  res.on('finish', () => {
    if (res.statusCode === 401) {
      const cur = attempts.get(ip);
      if (!cur || now - cur.first >= WINDOW_MS) attempts.set(ip, { first: now, count: 1 });
      else cur.count++;
    } else if (res.statusCode === 200) {
      attempts.delete(ip);
    }
  });
  next();
}
