import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import db from './db.js';

const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  const attempt = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (attempt.length !== expected.length) return false;
  return timingSafeEqual(attempt, expected);
}

export function ensureAdmin(username, password) {
  const existing = db.prepare('SELECT id FROM admins WHERE username = ?').get(username);
  if (existing) return;
  const { salt, hash } = hashPassword(password);
  db.prepare('INSERT INTO admins (username, salt, hash) VALUES (?, ?, ?)').run(username, salt, hash);
  console.log(`Admin account created for "${username}".`);
}

export function login(username, password) {
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!admin) return null;
  if (!verifyPassword(password, admin.salt, admin.hash)) return null;

  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  db.prepare('INSERT INTO sessions (token, username, expires_at) VALUES (?, ?, ?)').run(token, username, expiresAt);
  return { token, expiresAt };
}

export function verifyToken(token) {
  if (!token) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  if (session.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return session.username;
}

export function requireAdmin(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  return verifyToken(token);
}
