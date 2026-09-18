import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import db from './db.js';

const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

function tokenDigest(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  try {
    const attempt = scryptSync(String(password || ''), salt, 64);
    const expected = Buffer.from(hash, 'hex');
    if (attempt.length !== expected.length) return false;
    return timingSafeEqual(attempt, expected);
  } catch {
    return false;
  }
}

export function ensureAdmin(username, password) {
  const cleanUsername = String(username || '').trim();
  if (!cleanUsername || String(password || '').length < 12) {
    throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD are required, and the admin password must be at least 12 characters.');
  }
  const existing = db.prepare('SELECT id FROM admins WHERE username = ?').get(cleanUsername);
  if (existing) return;
  const { salt, hash } = hashPassword(password);
  db.prepare('INSERT INTO admins (username, salt, hash) VALUES (?, ?, ?)').run(cleanUsername, salt, hash);
  console.log(`Admin account created for "${cleanUsername}".`);
}

export function login(username, password) {
  const cleanUsername = String(username || '').trim();
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(cleanUsername);
  if (!admin || !verifyPassword(password, admin.salt, admin.hash)) return null;

  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  db.prepare('INSERT INTO sessions (token, username, expires_at) VALUES (?, ?, ?)').run(tokenDigest(token), cleanUsername, expiresAt);
  return { token, expiresAt };
}

export function verifyToken(token) {
  if (!token) return null;
  const digest = tokenDigest(token);
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(digest);
  if (!session) return null;
  if (session.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(digest);
    return null;
  }
  return session.username;
}

export function requireAdmin(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  return verifyToken(token);
}

export function registerStudent({ name, email, password, institution = '', study_field = '', study_year = '' }) {
  const cleanName = String(name || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (cleanName.length < 2 || cleanName.length > 120) throw new Error('Please enter your full name.');
  if (!/^\S+@\S+\.\S+$/.test(cleanEmail) || cleanEmail.length > 254) throw new Error('Please enter a valid email address.');
  if (String(password || '').length < 8 || String(password || '').length > 128) throw new Error('Password must be between 8 and 128 characters.');
  const existing = db.prepare('SELECT id FROM students WHERE lower(email)=lower(?)').get(cleanEmail);
  if (existing) throw new Error('An account with this email already exists.');
  const { salt, hash } = hashPassword(password);
  const result = db.prepare(`INSERT INTO students (name,email,password_salt,password_hash,institution,study_field,study_year) VALUES (?,?,?,?,?,?,?)`)
    .run(cleanName, cleanEmail, salt, hash, String(institution || '').trim().slice(0, 200), String(study_field || '').trim().slice(0, 120), String(study_year || '').trim().slice(0, 40));
  return createStudentSession(result.lastInsertRowid);
}

export function loginStudent(email, password) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const student = db.prepare('SELECT * FROM students WHERE lower(email)=lower(?)').get(cleanEmail);
  if (!student || !verifyPassword(String(password || ''), student.password_salt, student.password_hash)) return null;
  return createStudentSession(student.id);
}

function createStudentSession(studentId) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  db.prepare('INSERT INTO student_sessions (token, student_id, expires_at) VALUES (?, ?, ?)').run(tokenDigest(token), studentId, expiresAt);
  return { token, expiresAt, student: getStudent(studentId) };
}

export function verifyStudentToken(token) {
  if (!token) return null;
  const digest = tokenDigest(token);
  const session = db.prepare('SELECT * FROM student_sessions WHERE token=?').get(digest);
  if (!session) return null;
  if (session.expires_at < Date.now()) {
    db.prepare('DELETE FROM student_sessions WHERE token=?').run(digest);
    return null;
  }
  return getStudent(session.student_id);
}

export function logoutStudent(token) {
  if (token) db.prepare('DELETE FROM student_sessions WHERE token=?').run(tokenDigest(token));
}

export function getStudent(id) {
  return db.prepare('SELECT id,name,email,institution,study_field,study_year,created_at,updated_at FROM students WHERE id=?').get(id) || null;
}

export function updateStudent(id, data) {
  const current = db.prepare('SELECT * FROM students WHERE id=?').get(id);
  if (!current) return null;
  const name = String(data.name ?? current.name).trim();
  if (name.length < 2 || name.length > 120) throw new Error('Please enter your full name.');
  db.prepare(`UPDATE students SET name=?, institution=?, study_field=?, study_year=?, updated_at=datetime('now') WHERE id=?`)
    .run(name, String(data.institution ?? current.institution ?? '').trim().slice(0, 200), String(data.study_field ?? current.study_field ?? '').trim().slice(0, 120), String(data.study_year ?? current.study_year ?? '').trim().slice(0, 40), id);
  return getStudent(id);
}

export function cleanupExpiredSessions() {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM student_sessions WHERE expires_at < ?').run(now);
}
