import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db.js';
import { ensureAdmin, login, requireAdmin, registerStudent, loginStudent, verifyStudentToken, logoutStudent, updateStudent, cleanupExpiredSessions } from './auth.js';
import { syncPublicBursarySources } from './source-sync.js';

// Load local .env automatically during development. Production hosts inject env vars.
if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile('.env'); } catch (err) { if (err?.code !== 'ENOENT') console.warn('Could not load .env:', err.message); }
}

const NODE_ENV = String(process.env.NODE_ENV || 'development').toLowerCase();
const IS_PRODUCTION = NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 5000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || '').trim();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_API_URL = process.env.RESEND_API_URL || 'https://api.resend.com/emails';
const EMAIL_FROM = process.env.EMAIL_FROM || '';
const APP_BASE_URL = (process.env.APP_BASE_URL || (IS_PRODUCTION ? '' : 'http://localhost:3000')).replace(/\/$/, '');
const PUBLIC_API_BASE_URL = (process.env.PUBLIC_API_BASE_URL || (IS_PRODUCTION ? '' : `http://localhost:${PORT}`)).replace(/\/$/, '');
const MONITOR_SECRET = process.env.MONITOR_SECRET || '';
const AUTO_REPLACE_OUTDATED = String(process.env.AUTO_REPLACE_OUTDATED || 'false').toLowerCase() === 'true';
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || (IS_PRODUCTION ? '' : 'http://localhost:3000,http://127.0.0.1:3000')).split(',').map(x => x.trim()).filter(Boolean);

let EFFECTIVE_ADMIN_USERNAME = ADMIN_USERNAME;
let EFFECTIVE_ADMIN_PASSWORD = ADMIN_PASSWORD;

// Local development should be runnable immediately. Production remains strict.
// If local admin credentials are missing, create a temporary strong credential so
// the API can start; the credential is printed once to the terminal.
if (!IS_PRODUCTION && (!EFFECTIVE_ADMIN_USERNAME || EFFECTIVE_ADMIN_PASSWORD.length < 12)) {
  EFFECTIVE_ADMIN_USERNAME = EFFECTIVE_ADMIN_USERNAME || 'admin';
  EFFECTIVE_ADMIN_PASSWORD = randomBytes(18).toString('base64url');
  console.warn(`Local development admin created: ${EFFECTIVE_ADMIN_USERNAME}`);
  console.warn(`Local development admin password: ${EFFECTIVE_ADMIN_PASSWORD}`);
  console.warn('For production, set ADMIN_USERNAME and ADMIN_PASSWORD in the hosting environment.');
}
if (IS_PRODUCTION && (!EFFECTIVE_ADMIN_USERNAME || EFFECTIVE_ADMIN_PASSWORD.length < 12)) {
  throw new Error('Startup blocked: set ADMIN_USERNAME and a unique ADMIN_PASSWORD of at least 12 characters.');
}
if (IS_PRODUCTION && (!APP_BASE_URL || !PUBLIC_API_BASE_URL || !MONITOR_SECRET || CORS_ORIGINS.length === 0)) throw new Error('Startup blocked: production requires APP_BASE_URL, PUBLIC_API_BASE_URL, MONITOR_SECRET and CORS_ORIGINS.');
if (RESEND_API_KEY && !EMAIL_FROM) throw new Error('Startup blocked: EMAIL_FROM is required when RESEND_API_KEY is configured.');

ensureAdmin(EFFECTIVE_ADMIN_USERNAME, EFFECTIVE_ADMIN_PASSWORD);
cleanupExpiredSessions();

// ---------- helpers ----------
const rateBuckets = new Map();
const RATE_LIMITS = { auth: { windowMs: 60_000, max: 10 }, ai: { windowMs: 60_000, max: 20 }, public: { windowMs: 60_000, max: 120 } };
function requestIp(req) { return String(req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, ''); }
function rateLimit(req, res, bucketName) {
  const config = RATE_LIMITS[bucketName] || RATE_LIMITS.public;
  const key = `${bucketName}:${requestIp(req)}`; const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= config.windowMs) bucket = { startedAt: now, count: 0 };
  bucket.count += 1; rateBuckets.set(key, bucket);
  if (bucket.count > config.max) {
    const retryAfter = Math.max(1, Math.ceil((bucket.startedAt + config.windowMs - now) / 1000));
    sendJSON(res, 429, { error: 'Too many requests. Please try again shortly.' }, { 'Retry-After': String(retryAfter) });
    return false;
  }
  return true;
}
setInterval(() => { const now=Date.now(); for (const [key,b] of rateBuckets) if (now-b.startedAt > 5*60_000) rateBuckets.delete(key); cleanupExpiredSessions(); }, 5*60_000).unref();
function allowedOrigin(req) { const origin=String(req.headers.origin || ''); if (!origin) return null; return CORS_ORIGINS.includes(origin) ? origin : null; }
function sendJSON(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body); const origin = res.__fundisaOrigin || null;
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'X-Frame-Options':'DENY', 'Referrer-Policy':'strict-origin-when-cross-origin', 'Cross-Origin-Resource-Policy':'same-site', ...(origin ? {'Access-Control-Allow-Origin':origin,'Vary':'Origin'} : {}), 'Access-Control-Allow-Headers':'Content-Type, Authorization, X-Monitor-Secret', 'Access-Control-Allow-Methods':'GET, POST, PUT, DELETE, OPTIONS', ...extraHeaders });
  res.end(payload);
}
function readBody(req, maxBytes = 250_000) {
  return new Promise((resolve, reject) => {
    let raw=''; let tooLarge=false;
    req.on('data', chunk => { if (raw.length + chunk.length > maxBytes) { tooLarge=true; return; } raw += chunk; });
    req.on('end', () => { if (tooLarge) return reject(Object.assign(new Error('Request body is too large.'),{statusCode:413})); if(!raw) return resolve({}); try{resolve(JSON.parse(raw));}catch{reject(Object.assign(new Error('Invalid JSON body'),{statusCode:400}));} });
    req.on('error', reject);
  });
}

function rowToBursary(row) {
  return { ...row, fields: JSON.parse(row.fields) };
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function escapeHTML(value = '') {
  return String(value).replace(/[&<>\"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '\"':'&quot;', "'":'&#39;' }[ch]));
}

function normalizeEmail(email) { return String(email || '').trim().toLowerCase(); }

function studentFromRequest(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  return { token, student: verifyStudentToken(token) };
}


const FRONTEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'frontend');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json'
};
async function serveFrontend(pathname, res) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const safePath = normalize(requested).replace(/^([.][.][/\\])+/, '');
  const filePath = join(FRONTEND_DIR, safePath);
  if (!filePath.startsWith(FRONTEND_DIR)) return false;
  try {
    const body = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    });
    res.end(body);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

function requireMonitor(req,res){
  if (!MONITOR_SECRET || req.headers['x-monitor-secret'] !== MONITOR_SECRET) { sendJSON(res,401,{error:'Unauthorized'}); return false; }
  return true;
}

function requireStudent(req, res) {
  const { student } = studentFromRequest(req);
  if (!student) { sendJSON(res, 401, { error: 'Please log in to continue.' }); return null; }
  return student;
}

function studentAuth(req, res, mode) {
  return readBody(req).then(body => {
    try {
      const result = mode === 'register'
        ? registerStudent(body)
        : loginStudent(body.email, body.password);
      if (!result) return sendJSON(res, 401, { error: 'Email or password is incorrect.' });
      sendJSON(res, mode === 'register' ? 201 : 200, result);
    } catch (err) {
      sendJSON(res, err.statusCode || 400, { error: err.message });
    }
  });
}

async function getStudentProfile(req, res) {
  const student = requireStudent(req, res);
  if (!student) return;
  sendJSON(res, 200, { student });
}

async function updateStudentProfile(req, res) {
  const student = requireStudent(req, res);
  if (!student) return;
  try {
    const body = await readBody(req);
    sendJSON(res, 200, { student: updateStudent(student.id, body) });
  } catch (err) {
    sendJSON(res, 400, { error: err.message });
  }
}

async function studentLogout(req, res) {
  const { token } = studentFromRequest(req);
  logoutStudent(token);
  sendJSON(res, 200, { ok: true });
}

async function listStudentSaved(req, res) {
  const student = requireStudent(req, res);
  if (!student) return;
  const rows = db.prepare(`SELECT s.bursary_id AS id, s.status, s.created_at, s.updated_at
    FROM saved_bursaries s WHERE s.student_id=? ORDER BY s.updated_at DESC`).all(student.id);
  sendJSON(res, 200, { saved: rows });
}

async function saveStudentBursary(req, res) {
  const student = requireStudent(req, res);
  if (!student) return;
  try {
    const body = await readBody(req);
    const id = String(body.bursary_id || '').trim();
    if (!id) return sendJSON(res, 400, { error: 'bursary_id is required.' });
    const exists = db.prepare('SELECT id FROM bursaries WHERE id=?').get(id);
    if (!exists) return sendJSON(res, 404, { error: 'Bursary not found.' });
    db.prepare(`INSERT INTO saved_bursaries(student_id,bursary_id,status) VALUES(?,?,?)
      ON CONFLICT(student_id,bursary_id) DO UPDATE SET status=excluded.status, updated_at=datetime('now')`)
      .run(student.id, id, String(body.status || 'Saved'));
    sendJSON(res, 200, { ok: true });
  } catch (err) { sendJSON(res, 400, { error: err.message }); }
}

async function deleteStudentBursary(req, res) {
  const student = requireStudent(req, res);
  if (!student) return;
  const id = decodeURIComponent(req.url.split('/').pop());
  db.prepare('DELETE FROM saved_bursaries WHERE student_id=? AND bursary_id=?').run(student.id, id);
  sendJSON(res, 200, { ok: true });
}

function makeUnsubscribeToken(email) {
  return createHash('sha256').update(`${normalizeEmail(email)}:${randomBytes(24).toString('hex')}`).digest('hex');
}

async function sendEmail({ to, subject, html, text }) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured');
  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html, text })
  });
  if (!response.ok) throw new Error(`Resend API error ${response.status}: ${await response.text()}`);
  return response.json();
}

function unsubscribeURL(token) { return `${PUBLIC_API_BASE_URL}/api/notify/unsubscribe?token=${encodeURIComponent(token)}`; }

async function sendWelcomeEmail(email, field, token) {
  const scope = field && field !== 'Any field' ? `new ${field} bursaries` : 'new bursary opportunities';
  const url = unsubscribeURL(token);
  return sendEmail({
    to: email,
    subject: 'Welcome to Fundisa bursary alerts',
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#264C47;max-width:600px;margin:auto"><h1 style="font-family:Georgia,serif">Thank you for joining Fundisa.</h1><p>Your email has been submitted successfully. Fundisa will keep you updated about ${escapeHTML(scope)}.</p><p>When a relevant bursary is added or materially updated on Fundisa, you will receive an email with the opportunity, deadline and application link.</p><p style="font-size:13px;color:#6b6b63">You can unsubscribe at any time: <a href="${url}">unsubscribe</a>.</p></div>`,
    text: `Thank you for joining Fundisa. Your email has been submitted successfully. Fundisa will keep you updated about ${scope}. You can unsubscribe here: ${url}`
  });
}

function subscriberMatchesField(subscriber, bursary) {
  const wanted = String(subscriber.field || 'Any field').trim().toLowerCase();
  if (!wanted || wanted === 'any field') return true;
  return (bursary.fields || []).some(f => String(f).toLowerCase() === wanted || String(f).toLowerCase() === 'all fields');
}

async function notifySubscribersAboutBursary(bursary, action = 'new') {
  if (!RESEND_API_KEY) { console.warn('Notification email skipped: RESEND_API_KEY is not configured.'); return { sent: 0, skipped: true }; }
  const subscribers = db.prepare('SELECT * FROM subscribers WHERE active = 1').all().filter(s => subscriberMatchesField(s, bursary));
  let sent = 0;
  for (const subscriber of subscribers) {
    try {
      const token = subscriber.unsubscribe_token || makeUnsubscribeToken(subscriber.email);
      if (!subscriber.unsubscribe_token) db.prepare('UPDATE subscribers SET unsubscribe_token=? WHERE id=?').run(token, subscriber.id);
      const verb = action === 'new' ? 'A new bursary is available' : 'A bursary you may care about was updated';
      const url = unsubscribeURL(token);
      await sendEmail({
        to: subscriber.email,
        subject: `${verb}: ${bursary.name}`,
        html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#264C47;max-width:620px;margin:auto"><p style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#827056">FUNDISA BURSARY ALERT</p><h2 style="font-family:Georgia,serif">${escapeHTML(bursary.name)}</h2><p><strong>${escapeHTML(bursary.provider)}</strong></p><p>${escapeHTML(bursary.description || 'A bursary opportunity on Fundisa.')}</p><p><strong>Deadline:</strong> ${escapeHTML(bursary.deadline || 'Check the official provider site')}</p><p><a href="${escapeHTML(bursary.url || '#')}" style="display:inline-block;background:#264C47;color:#fff;padding:11px 18px;border-radius:999px;text-decoration:none">View application</a></p><p style="font-size:12px;color:#6b6b63">Always confirm the latest eligibility and deadline on the official provider site. <a href="${url}">Unsubscribe from Fundisa alerts</a>.</p></div>`,
        text: `${verb}: ${bursary.name} (${bursary.provider}). Deadline: ${bursary.deadline || 'Check the official provider site'}. Apply: ${bursary.url || ''}

Always confirm details on the official provider site. Unsubscribe: ${url}`
      });
      db.prepare("UPDATE subscribers SET last_notified_at=datetime('now') WHERE id=?").run(subscriber.id);
      sent += 1;
    } catch (err) {
      console.error(`Could not notify ${subscriber.email}:`, err.message);
    }
  }
  return { sent, skipped: false };
}


function getStudentPreferences(studentId) {
  let row = db.prepare('SELECT * FROM notification_preferences WHERE student_id=?').get(studentId);
  if (!row) {
    db.prepare('INSERT INTO notification_preferences (student_id) VALUES (?)').run(studentId);
    row = db.prepare('SELECT * FROM notification_preferences WHERE student_id=?').get(studentId);
  }
  return { ...row, email_deadlines: !!row.email_deadlines, email_new_matches: !!row.email_new_matches, email_updates: !!row.email_updates, reminder_days: JSON.parse(row.reminder_days || '[14,7,3,1]') };
}

async function getStudentNotificationSettings(req,res){
  const student=requireStudent(req,res); if(!student)return;
  sendJSON(res,200,{preferences:getStudentPreferences(student.id)});
}

async function updateStudentNotificationSettings(req,res){
  const student=requireStudent(req,res); if(!student)return;
  const body=await readBody(req);
  const days=Array.isArray(body.reminder_days)?body.reminder_days.map(Number).filter(n=>[14,7,3,1].includes(n)):[14,7,3,1];
  db.prepare(`INSERT INTO notification_preferences(student_id,email_deadlines,email_new_matches,email_updates,reminder_days,updated_at) VALUES(?,?,?,?,?,datetime('now'))
    ON CONFLICT(student_id) DO UPDATE SET email_deadlines=excluded.email_deadlines,email_new_matches=excluded.email_new_matches,email_updates=excluded.email_updates,reminder_days=excluded.reminder_days,updated_at=datetime('now')`)
    .run(student.id,body.email_deadlines===false?0:1,body.email_new_matches===false?0:1,body.email_updates===false?0:1,JSON.stringify([...new Set(days)].sort((a,b)=>b-a)));
  sendJSON(res,200,{preferences:getStudentPreferences(student.id)});
}


function daysUntilDeadline(dateText){
  if(!dateText) return null;
  const d=new Date(`${dateText}T23:59:59Z`);
  if(Number.isNaN(d.getTime())) return null;
  return Math.ceil((d-new Date())/86400000);
}

function buildCopilotContext(student){
  const saved=db.prepare(`SELECT s.status AS saved_status,b.* FROM saved_bursaries s JOIN bursaries b ON b.id=s.bursary_id WHERE s.student_id=? ORDER BY s.updated_at DESC`).all(student.id).map(r=>({
    id:r.id,name:r.name,provider:r.provider,fields:JSON.parse(r.fields),description:r.description,deadline:r.deadline,deadline_date:r.deadline_date,status:r.status,url:r.url,saved_status:r.saved_status,days_left:daysUntilDeadline(r.deadline_date)
  }));
  const matches=db.prepare(`SELECT * FROM bursaries WHERE status IN ('open','upcoming') ORDER BY created_at DESC LIMIT 80`).all().map(rowToBursary).filter(b=>studentMatchScore(student,b)>=80).slice(0,12).map(b=>({id:b.id,name:b.name,provider:b.provider,fields:b.fields,deadline:b.deadline,deadline_date:b.deadline_date,status:b.status,url:b.url,days_left:daysUntilDeadline(b.deadline_date)}));
  return {student:{name:student.name,institution:student.institution||'',study_field:student.study_field||'',study_year:student.study_year||''},saved,matches};
}

function fallbackCopilotPlan(context){
  const tasks=[];
  const saved=context.saved.filter(x=>['Saved','Applied'].includes(x.saved_status) && x.status!=='closed');
  const urgent=saved.filter(x=>x.days_left!==null && x.days_left>=0).sort((a,b)=>a.days_left-b.days_left)[0];
  if(urgent) tasks.push({priority:'urgent',action:urgent.saved_status==='Applied'?'Check your application status and any missing follow-up items.':'Open the opportunity and work through its application requirements.',reason:`${urgent.name} has ${urgent.days_left===0?'a deadline today':urgent.days_left===1?'1 day left':`${urgent.days_left} days left`}.`,bursary_id:urgent.id});
  const applied=saved.find(x=>x.saved_status==='Applied');
  if(applied && (!urgent || applied.id!==urgent.id)) tasks.push({priority:'next',action:'Review your submitted application and note any follow-up date or outstanding requirement.',reason:`You marked ${applied.name} as Applied.`,bursary_id:applied.id});
  const unsaved=context.matches.find(x=>!context.saved.some(s=>s.id===x.id));
  if(unsaved) tasks.push({priority:'next',action:'Review one new Funding Radar match and save it if it fits your course and circumstances.',reason:`${unsaved.name} matches the study profile you gave Fundisa.`,bursary_id:unsaved.id});
  tasks.push({priority:'prepare',action:'Keep a reusable application checklist ready: academic results, proof of registration or admission, ID, and any provider-specific items.',reason:'Being prepared reduces last-minute work when a funding window opens.'});
  return {headline:context.student.name?`Your funding focus for today, ${context.student.name.split(' ')[0]}.`:'Your funding focus for today.',summary:saved.length?`Start with the saved opportunity closest to its deadline, then keep one backup route moving.`:'Build your first funding shortlist, then save the opportunities you want Fundisa to watch.',tasks:tasks.slice(0,4)};
}

async function getStudentCopilot(req,res){
  const student=requireStudent(req,res); if(!student)return;
  const context=buildCopilotContext(student);
  const fallback=fallbackCopilotPlan(context);
  if(!GEMINI_API_KEY) return sendJSON(res,200,{plan:fallback,ai:false});
  const systemPrompt=`You are Fundisa AI Copilot, a practical funding planning assistant for South African students. Create a short action plan for today using ONLY the supplied student profile, saved bursaries, and current catalogue matches. Never invent eligibility, deadlines, documents, providers, application links, or bursaries. A match is only a relevance signal, not an eligibility decision. Do not ask for passwords, payment details, ID numbers, or other unnecessary sensitive information. Keep advice concrete and achievable. Return ONLY JSON in this shape: {"headline":"...","summary":"...","tasks":[{"priority":"urgent|next|prepare","action":"...","reason":"...","bursary_id":"<id or empty>"}]} with 3-5 tasks. Put the most time-sensitive task first. If a deadline date is null, do not invent one.`;
  try{
    const result=await callGeminiText(systemPrompt,[{role:'user',parts:[{text:JSON.stringify(context)}]}],{googleSearch:false,maxOutputTokens:900,json:true});
    const parsed=JSON.parse(result.text.replace(/^```json/,'').replace(/^```/,'').replace(/```$/,'').trim());
    const validIds=new Set([...context.saved,...context.matches].map(x=>x.id));
    const tasks=Array.isArray(parsed.tasks)?parsed.tasks.map(t=>({priority:['urgent','next','prepare'].includes(t.priority)?t.priority:'next',action:String(t.action||'').slice(0,240),reason:String(t.reason||'').slice(0,240),bursary_id:validIds.has(t.bursary_id)?t.bursary_id:''})).filter(t=>t.action).slice(0,5):[];
    if(!tasks.length) return sendJSON(res,200,{plan:fallback,ai:false});
    sendJSON(res,200,{plan:{headline:String(parsed.headline||fallback.headline).slice(0,140),summary:String(parsed.summary||fallback.summary).slice(0,260),tasks},ai:true});
  }catch(err){
    console.error('Copilot error:',err.message);
    sendJSON(res,200,{plan:fallback,ai:false});
  }
}

function defaultApplicationTasks(bursary) {
  const tasks = [
    { key:'profile', label:'Complete your Fundisa profile' },
    { key:'requirements', label:'Read the provider eligibility and application requirements' },
    { key:'academic', label:'Prepare your latest academic results or transcript' },
    { key:'registration', label:'Confirm your registration or admission details' },
    { key:'id', label:'Prepare a valid South African ID or required identity document' },
    { key:'letter', label:'Prepare your motivational letter if the provider requests one' },
    { key:'submit', label:'Submit the application on the official provider application page' }
  ];
  const text = `${bursary?.eligibility||''} ${bursary?.description||''}`.toLowerCase();
  if (!/motivat|letter/.test(text)) tasks.splice(5,1);
  return tasks;
}

async function getApplicationReadiness(req,res){
  const student=requireStudent(req,res); if(!student)return;
  const bursaryId=String(new URL(req.url,`http://${req.headers.host}`).searchParams.get('bursary_id')||'').trim();
  if(!bursaryId) return sendJSON(res,400,{error:'bursary_id is required.'});
  const row=db.prepare('SELECT * FROM bursaries WHERE id=?').get(bursaryId);
  if(!row) return sendJSON(res,404,{error:'Bursary not found.'});
  const bursary=rowToBursary(row);
  const defaults=defaultApplicationTasks(bursary);
  const existing=db.prepare('SELECT task_key,label,done FROM application_checklist_items WHERE student_id=? AND bursary_id=?').all(student.id,bursaryId);
  const byKey=new Map(existing.map(x=>[x.task_key,x]));
  for(const task of defaults){
    if(!byKey.has(task.key)){
      db.prepare('INSERT OR IGNORE INTO application_checklist_items(student_id,bursary_id,task_key,label,done) VALUES(?,?,?,?,0)').run(student.id,bursaryId,task.key,task.label);
    }
  }
  const tasks=db.prepare('SELECT task_key,label,done,updated_at FROM application_checklist_items WHERE student_id=? AND bursary_id=? ORDER BY rowid').all(student.id,bursaryId);
  const done=tasks.filter(x=>x.done).length;
  sendJSON(res,200,{bursary, tasks, readiness:tasks.length?Math.round(done/tasks.length*100):0});
}

async function updateApplicationReadiness(req,res){
  const student=requireStudent(req,res); if(!student)return;
  try{
    const body=await readBody(req); const bursaryId=String(body.bursary_id||'').trim(); const taskKey=String(body.task_key||'').trim();
    if(!bursaryId||!taskKey) return sendJSON(res,400,{error:'bursary_id and task_key are required.'});
    const row=db.prepare('SELECT * FROM bursaries WHERE id=?').get(bursaryId); if(!row) return sendJSON(res,404,{error:'Bursary not found.'});
    const task=defaultApplicationTasks(rowToBursary(row)).find(x=>x.key===taskKey); if(!task) return sendJSON(res,400,{error:'Unknown checklist task.'});
    db.prepare(`INSERT INTO application_checklist_items(student_id,bursary_id,task_key,label,done,updated_at) VALUES(?,?,?,?,?,datetime('now'))
      ON CONFLICT(student_id,bursary_id,task_key) DO UPDATE SET done=excluded.done, updated_at=datetime('now')`).run(student.id,bursaryId,taskKey,task.label,body.done?1:0);
    const tasks=db.prepare('SELECT task_key,label,done,updated_at FROM application_checklist_items WHERE student_id=? AND bursary_id=? ORDER BY rowid').all(student.id,bursaryId);
    const done=tasks.filter(x=>x.done).length;
    sendJSON(res,200,{ok:true,tasks,readiness:tasks.length?Math.round(done/tasks.length*100):0});
  }catch(err){sendJSON(res,400,{error:err.message});}
}

async function listStudentNotifications(req,res){
  const student=requireStudent(req,res); if(!student)return;
  const rows=db.prepare(`SELECT id,bursary_id,type,title,message,read_at,created_at FROM student_notifications WHERE student_id=? ORDER BY created_at DESC LIMIT 30`).all(student.id);
  sendJSON(res,200,{notifications:rows});
}

async function markStudentNotificationsRead(req,res){
  const student=requireStudent(req,res); if(!student)return;
  db.prepare("UPDATE student_notifications SET read_at=datetime('now') WHERE student_id=? AND read_at IS NULL").run(student.id);
  sendJSON(res,200,{ok:true});
}

function createStudentNotification(studentId,bursaryId,type,title,message){
  db.prepare(`INSERT OR IGNORE INTO student_notifications(student_id,bursary_id,type,title,message) VALUES(?,?,?,?,?)`).run(studentId,bursaryId,type,title,message);
}

function studentMatchScore(student,bursary){
  const field=String(student.study_field||'').toLowerCase();
  if(!field) return 25;
  const fields=bursary.fields||[];
  return fields.some(f=>String(f).toLowerCase()==='all fields'||String(f).toLowerCase().includes(field)||field.includes(String(f).toLowerCase()))?90:15;
}

async function sendStudentDeadlineReminders(){
  const students=db.prepare('SELECT * FROM students').all(); let sent=0;
  for(const student of students){
    const pref=getStudentPreferences(student.id); if(!pref.email_deadlines) continue;
    const saved=db.prepare(`SELECT b.* FROM saved_bursaries s JOIN bursaries b ON b.id=s.bursary_id WHERE s.student_id=? AND s.status IN ('Saved','Applied') AND b.status IN ('open','upcoming')`).all(student.id);
    for(const bRow of saved){
      const b=rowToBursary(bRow); if(!b.deadline_date) continue;
      const d=Math.ceil((new Date(b.deadline_date+'T23:59:59Z')-new Date())/86400000);
      if(!pref.reminder_days.includes(d)) continue;
      const type=`deadline-${d}`;
      const title=d===1?`Deadline tomorrow: ${b.name}`:`${d} days left: ${b.name}`;
      const message=`Your saved Fundisa opportunity closes in ${d} day${d===1?'':'s'}.`;
      createStudentNotification(student.id,b.id,type,title,message);
      if(RESEND_API_KEY) try{await sendEmail({to:student.email,subject:`Fundisa deadline rescue: ${b.name}`,html:`<div style="font-family:Arial,sans-serif;line-height:1.6;color:#264C47;max-width:620px;margin:auto"><p style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#827056">DEADLINE RESCUE</p><h2 style="font-family:Georgia,serif">${escapeHTML(title)}</h2><p>${escapeHTML(message)}</p><p><strong>Deadline:</strong> ${escapeHTML(b.deadline||b.deadline_date)}</p><p><a href="${escapeHTML(b.url||'#')}" style="display:inline-block;background:#264C47;color:#fff;padding:11px 18px;border-radius:999px;text-decoration:none">Open opportunity</a></p><p style="font-size:12px;color:#6b6b63">Check the official provider site before submitting your application.</p></div>`,text:`${title}. ${message} Deadline: ${b.deadline||b.deadline_date}. Apply: ${b.url||''}`});sent++;}catch(e){console.error('Deadline reminder failed:',e.message)}
    }
  }
  return {sent,skipped:false};
}

async function sendStudentNewMatchAlerts(){
  const students=db.prepare('SELECT * FROM students').all(); const bursaries=db.prepare("SELECT * FROM bursaries WHERE status IN ('open','upcoming') ORDER BY created_at DESC LIMIT 50").all(); let sent=0;
  for(const student of students){
    const pref=getStudentPreferences(student.id); if(!pref.email_new_matches) continue;
    for(const r of bursaries){ if(studentMatchScore(student,rowToBursary(r))<80) continue; const b=rowToBursary(r); const type='new-match';
      const before=db.prepare('SELECT id FROM student_notifications WHERE student_id=? AND bursary_id=? AND type=?').get(student.id,b.id,type); if(before) continue;
      createStudentNotification(student.id,b.id,type,`New match: ${b.name}`,`Fundisa found a bursary that matches your profile.`);
      if(RESEND_API_KEY) try{await sendEmail({to:student.email,subject:`Fundisa found a match: ${b.name}`,html:`<div style="font-family:Arial,sans-serif;line-height:1.6;color:#264C47;max-width:620px;margin:auto"><p style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#827056">FUNDING RADAR MATCH</p><h2 style="font-family:Georgia,serif">${escapeHTML(b.name)}</h2><p>Fundisa found an opportunity that matches your study profile.</p><p><strong>Provider:</strong> ${escapeHTML(b.provider)}<br><strong>Deadline:</strong> ${escapeHTML(b.deadline||'Check official site')}</p><p><a href="${escapeHTML(b.url||'#')}" style="display:inline-block;background:#264C47;color:#fff;padding:11px 18px;border-radius:999px;text-decoration:none">Review opportunity</a></p></div>`,text:`Fundisa found a match: ${b.name}. Provider: ${b.provider}. Deadline: ${b.deadline||'Check official site'}. Apply: ${b.url||''}`});sent++;}catch(e){console.error('Match alert failed:',e.message)}
    }
  } return {sent,skipped:false};
}

async function runNotificationSweep(req,res){
  if(!requireMonitor(req,res)) return;
  const deadlines=await sendStudentDeadlineReminders();
  const matches=await sendStudentNewMatchAlerts();
  sendJSON(res,200,{deadlines,matches});
}

// ---------- Gemini helper ----------
// Shared by /api/assistant and /api/letter-assistant. Uses Gemini's
// generateContent endpoint with the model set to JSON-only output mode,
// so callers get back a plain string of JSON text to parse themselves.
async function callGemini(systemPrompt, userMessage, maxOutputTokens) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        responseMimeType: 'application/json',
        maxOutputTokens
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const candidate = data.candidates && data.candidates[0];
  const text = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0] && candidate.content.parts[0].text;
  if (!text) throw new Error('Gemini returned no usable text (candidate may have been blocked by safety filters)');
  return text;
}


async function callGeminiText(
  systemPrompt,
  contents,
  {
    googleSearch = false,
    maxOutputTokens = 1400,
    json = false
  } = {}
) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const maxRetries = 2;

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  const requestBody = {
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    contents: Array.isArray(contents)
      ? contents
      : [
          {
            role: 'user',
            parts: [{ text: String(contents) }]
          }
        ],
    ...(googleSearch
      ? {
          tools: [{ google_search: {} }]
        }
      : {}),
    generationConfig: {
      maxOutputTokens,
      ...(json
        ? {
            responseMimeType: 'application/json'
          }
        : {})
    }
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': GEMINI_API_KEY
          },
          body: JSON.stringify(requestBody)
        }
      );

      const responseText = await response.text();

      if (!response.ok) {
        // Do NOT repeatedly retry quota errors.
        // Retrying a free-tier quota error immediately will not create
        // additional quota and can make the situation worse.
        if (response.status === 429) {
          const error = new Error(
            'GEMINI_QUOTA_EXCEEDED: Gemini free-tier quota has been reached.'
          );
          error.code = 'GEMINI_QUOTA_EXCEEDED';
          error.status = 429;
          throw error;
        }

        // Temporary Gemini/server overload.
        // Retry with exponential backoff.
        const retryable =
          response.status === 500 ||
          response.status === 502 ||
          response.status === 503 ||
          response.status === 504;

        if (retryable && attempt < maxRetries) {
          const delay = 1500 * Math.pow(2, attempt);

          console.warn(
            `Gemini temporary error ${response.status}. ` +
            `Retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`
          );

          await sleep(delay);
          continue;
        }

        const error = new Error(
          `Gemini API error ${response.status}: ${responseText}`
        );

        error.status = response.status;
        error.code = retryable
          ? 'GEMINI_TEMPORARILY_UNAVAILABLE'
          : 'GEMINI_API_ERROR';

        throw error;
      }

      let data;

      try {
        data = JSON.parse(responseText);
      } catch {
        const error = new Error('Gemini returned an invalid response.');
        error.code = 'GEMINI_INVALID_RESPONSE';
        throw error;
      }

      const candidate = data.candidates?.[0];

      const text = candidate?.content?.parts
        ?.find(part => part.text)
        ?.text;

      if (!text) {
        const error = new Error('Gemini returned no text.');
        error.code = 'GEMINI_NO_TEXT';
        throw error;
      }

      return {
        text,
        groundingMetadata:
          candidate?.groundingMetadata ||
          data.groundingMetadata ||
          null
      };
    } catch (error) {
      // Network errors can be temporary too.
      if (
        !error.status &&
        attempt < maxRetries
      ) {
        const delay = 1500 * Math.pow(2, attempt);

        console.warn(
          `Gemini network error. ` +
          `Retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`
        );

        await sleep(delay);
        continue;
      }

      throw error;
    }
  }

  throw new Error('Gemini request failed after retries.');
}

// ---------- route handlers ----------
async function listBursaries(req, res, query) {
  const field = query.get('field');
  const search = (query.get('search') || '').toLowerCase();
  let rows = db.prepare('SELECT * FROM bursaries ORDER BY created_at DESC').all();
  let bursaries = rows.map(rowToBursary);

  if (field && field !== 'All') {
    bursaries = bursaries.filter(b => b.fields.includes(field));
  }
  if (search) {
    bursaries = bursaries.filter(b =>
      b.name.toLowerCase().includes(search) || b.provider.toLowerCase().includes(search)
    );
  }
  sendJSON(res, 200, { bursaries });
}

async function listFields(req, res) {
  const rows = db.prepare('SELECT fields FROM bursaries').all();
  const set = new Set();
  rows.forEach(r => JSON.parse(r.fields).forEach(f => set.add(f)));
  sendJSON(res, 200, { fields: ['All', ...Array.from(set).sort()] });
}

async function createBursary(req, res) {
  const username = requireAdmin(req);
  if (!username) return sendJSON(res, 401, { error: 'Unauthorized' });

  const body = await readBody(req);
  const required = ['name', 'provider', 'fields', 'deadline'];
  for (const key of required) {
    if (!body[key]) return sendJSON(res, 400, { error: `Missing field: ${key}` });
  }
  const id = body.id || body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) + '-' + randomBytes(3).toString('hex');

  db.prepare(`
    INSERT INTO bursaries (id, name, provider, fields, description, eligibility, deadline, deadline_date, status, url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, body.name, body.provider, JSON.stringify(body.fields),
    body.description || '', body.eligibility || '', body.deadline, body.deadline_date || null,
    body.status || 'open', body.url || ''
  );

  if (body.url) db.prepare('UPDATE bursaries SET source_url=? WHERE id=?').run(body.url, id);
  const row = db.prepare('SELECT * FROM bursaries WHERE id = ?').get(id);
  sendJSON(res, 201, { bursary: rowToBursary(row) });
  void notifySubscribersAboutBursary(rowToBursary(row), 'new');
}

async function updateBursary(req, res, id) {
  const username = requireAdmin(req);
  if (!username) return sendJSON(res, 401, { error: 'Unauthorized' });

  const existing = db.prepare('SELECT * FROM bursaries WHERE id = ?').get(id);
  if (!existing) return sendJSON(res, 404, { error: 'Bursary not found' });

  const body = await readBody(req);
  const merged = {
    name: body.name ?? existing.name,
    provider: body.provider ?? existing.provider,
    fields: body.fields ? JSON.stringify(body.fields) : existing.fields,
    description: body.description ?? existing.description,
    eligibility: body.eligibility ?? existing.eligibility,
    deadline: body.deadline ?? existing.deadline,
    deadline_date: body.deadline_date !== undefined ? (body.deadline_date || null) : existing.deadline_date,
    status: body.status ?? existing.status,
    url: body.url ?? existing.url
  };

  db.prepare(`
    UPDATE bursaries SET name=?, provider=?, fields=?, description=?, eligibility=?, deadline=?, deadline_date=?, status=?, url=?, source_url=?
    WHERE id=?
  `).run(merged.name, merged.provider, merged.fields, merged.description, merged.eligibility, merged.deadline, merged.deadline_date, merged.status, merged.url, merged.url, id);

  const row = db.prepare('SELECT * FROM bursaries WHERE id = ?').get(id);
  sendJSON(res, 200, { bursary: rowToBursary(row) });
  if (row.status === 'open' || row.status === 'upcoming') void notifySubscribersAboutBursary(rowToBursary(row), 'update');
}

async function deleteBursary(req, res, id) {
  const username = requireAdmin(req);
  if (!username) return sendJSON(res, 401, { error: 'Unauthorized' });

  const existing = db.prepare('SELECT id FROM bursaries WHERE id = ?').get(id);
  if (!existing) return sendJSON(res, 404, { error: 'Bursary not found' });

  db.prepare('DELETE FROM bursaries WHERE id = ?').run(id);
  sendJSON(res, 200, { deleted: id });
}

async function subscribe(req, res) {
  const body = await readBody(req);
  const email = normalizeEmail(body.email);
  const field = body.field || 'Any field';
  if (!isValidEmail(email)) return sendJSON(res, 400, { error: 'Valid email required' });

  const subscriber = db.prepare('SELECT * FROM subscribers WHERE lower(email)=lower(?)').get(email);
  const wasAlreadyActive = !!subscriber?.active;
  const token = subscriber?.unsubscribe_token || makeUnsubscribeToken(email);
  if (subscriber) {
    db.prepare("UPDATE subscribers SET field=?, active=1, unsubscribe_token=?, confirmed_at=datetime('now') WHERE id=?").run(field, token, subscriber.id);
  } else {
    db.prepare("INSERT INTO subscribers (email, field, active, confirmed_at, unsubscribe_token) VALUES (?, ?, 1, datetime('now'), ?)").run(email, field, token);
  }

  let welcomeSent = false;
  let emailError = '';
  if (!wasAlreadyActive && RESEND_API_KEY) {
    try { await sendWelcomeEmail(email, field, token); welcomeSent = true; }
    catch (err) { console.error('Welcome email error:', err); emailError = 'Your signup was saved, but the confirmation email could not be sent right now.'; }
  } else if (!RESEND_API_KEY) {
    emailError = 'Email alerts are saved, but outbound email is not configured yet.';
  }

  const message = wasAlreadyActive
    ? 'You are already subscribed. Fundisa will continue to send relevant bursary alerts.'
    : (emailError || 'Thank you for submitting your email. Fundisa will update you about bursaries.');
  sendJSON(res, 201, { subscribed: true, welcomeSent, alreadySubscribed: wasAlreadyActive, message });
}

async function unsubscribe(req, res, query) {
  const token = query.get('token');
  if (!token) return sendJSON(res, 400, { error: 'Missing unsubscribe token' });
  const result = db.prepare('UPDATE subscribers SET active=0 WHERE unsubscribe_token=?').run(token);
  res.writeHead(result.changes ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(result.changes ? `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#F4F1E8;color:#264C47;padding:60px 20px;text-align:center"><h1 style="font-family:Georgia,serif">Fundisa alerts turned off.</h1><p>You will no longer receive bursary notification emails from Fundisa.</p><p>You can subscribe again from the website at any time.</p></body></html>` : '<h1>Invalid or expired unsubscribe link.</h1>');
}

async function listSubscribers(req, res) {
  const username = requireAdmin(req);
  if (!username) return sendJSON(res, 401, { error: 'Unauthorized' });

  const rows = db.prepare('SELECT id, email, field, active, confirmed_at, last_notified_at, created_at FROM subscribers ORDER BY created_at DESC').all();
  sendJSON(res, 200, { subscribers: rows });
}

async function adminLogin(req, res) {
  const body = await readBody(req);
  if (!body.username || !body.password) return sendJSON(res, 400, { error: 'Username and password required' });

  const session = login(body.username, body.password);
  if (!session) return sendJSON(res, 401, { error: 'Invalid credentials' });

  sendJSON(res, 200, { token: session.token, expiresAt: session.expiresAt });
}

async function aiAssistant(req, res) {
  const body = await readBody(req);
  const query = (body.query || '').trim();
  if (!query) return sendJSON(res, 400, { error: 'query is required' });

  if (!GEMINI_API_KEY) {
    return sendJSON(res, 503, { error: 'Fundisa AI is not configured on this server. Add GEMINI_API_KEY to the backend environment and restart the server.' });
  }

  const rows = db.prepare('SELECT * FROM bursaries').all();
  const catalogue = rows.map(rowToBursary).map(b => ({
    id: b.id, name: b.name, fields: b.fields, description: b.description, deadline: b.deadline
  }));

  const systemPrompt = `You are a bursary-matching assistant for South African students on the Fundisa website. You will be given a student's description of their field of study and a JSON catalogue of currently open bursaries. Pick the 2-4 bursaries from the catalogue that best match the student, ranked best first. Respond ONLY with raw JSON (no markdown fences, no preamble) in exactly this shape:
{"matches":[{"id":"<bursary id from catalogue>","matchPct":<integer 50-99>,"why":"<one short sentence, plain language, explaining the fit to the student directly>"}]}
Only use ids that exist in the catalogue. If nothing is a good fit, return an empty matches array. Never invent bursaries not in the catalogue.

Catalogue:
${JSON.stringify(catalogue)}`;

  try {
    const text = await callGemini(systemPrompt, `Student's field of study: ${query}`, 1000);
    const cleaned = text.trim().replace(/^```json/, '').replace(/^```/, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    const matches = (parsed.matches || [])
      .map(m => ({ ...m, bursary: rows.find(r => r.id === m.id) }))
      .filter(m => m.bursary)
      .map(m => ({ id: m.id, matchPct: m.matchPct, why: m.why, bursary: rowToBursary(m.bursary) }));

    sendJSON(res, 200, { matches });
  } catch (err) {
    console.error('Assistant error:', err);
    sendJSON(res, 500, { error: 'Something went wrong reaching the AI assistant.' });
  }
}


async function chatAssistant(req, res) {
  const body = await readBody(req);
  const messages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  const latest = messages[messages.length - 1];
  if (!latest?.content?.trim()) return sendJSON(res, 400, { error: 'message is required' });
  if (!GEMINI_API_KEY) return sendJSON(res, 500, { error: 'Fundisa Chatbot is not configured yet. Add GEMINI_API_KEY on the backend.' });

  const catalogue = db.prepare('SELECT * FROM bursaries ORDER BY created_at DESC').all().map(rowToBursary).map(b => ({
    id: b.id, name: b.name, provider: b.provider, fields: b.fields, description: b.description,
    eligibility: b.eligibility, deadline: b.deadline, deadline_date: b.deadline_date, status: b.status, url: b.url,
    last_verified_at: b.last_verified_at, verification_status: b.verification_status
  }));
  const systemPrompt = `You are Fundisa Chatbot, the helpful bursary guide for South African students. Answer in plain, friendly English.\n\nYou have access to Fundisa's live bursary catalogue below. Never invent a bursary, deadline, eligibility requirement, provider, application URL, or document requirement. If the catalogue does not answer a question, use Google Search when useful, but prefer official provider sites and clearly say when a detail must be confirmed on the official site.\n\nYou can help students understand bursaries, application preparation, deadlines, eligibility, documents, and how Fundisa works. You are not a government official or bursary provider and must not guarantee that a student will receive funding. You must not ask for passwords, card details, or other unnecessary sensitive information.\n\nCATALOGUE:\n${JSON.stringify(catalogue)}`;
  const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content) }] }));

  try {
    const result = await callGeminiText(systemPrompt, contents, { googleSearch: true, maxOutputTokens: 900 });
    sendJSON(res, 200, { reply: result.text, sources: groundingSources(result.groundingMetadata) });
  } catch (err) {
    console.error('Chatbot error:', err);
    sendJSON(res, 500, { error: 'The Fundisa Chatbot could not respond right now. Please try again.' });
  }
}

// ---------- campaigns (student fundraisers) ----------
// Fundisa never touches the money. Every campaign links out to wherever
// the student's real donation page already lives (BackaBuddy, GoFundMe,
// a bank EFT page, etc). goal_amount / raised_amount are self-reported
// by the student and kept current by an admin - there's no live payment
// sync, because there's no in-house payment processing.
function rowToCampaign(row) {
  return { ...row, goal_amount: Number(row.goal_amount), raised_amount: Number(row.raised_amount) };
}

async function listCampaigns(req, res) {
  const rows = db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all();
  sendJSON(res, 200, { campaigns: rows.map(rowToCampaign) });
}

async function createCampaign(req, res) {
  const username = requireAdmin(req);
  if (!username) return sendJSON(res, 401, { error: 'Unauthorized' });

  const body = await readBody(req);
  const required = ['student_name', 'title', 'story', 'goal_amount', 'external_url'];
  for (const key of required) {
    if (!body[key]) return sendJSON(res, 400, { error: `Missing field: ${key}` });
  }
  const id = (body.student_name + '-' + body.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) + '-' + randomBytes(3).toString('hex');

  db.prepare(`
    INSERT INTO campaigns (id, student_name, title, story, field, goal_amount, raised_amount, external_url, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, body.student_name, body.title, body.story, body.field || '',
    Math.round(body.goal_amount), Math.round(body.raised_amount || 0),
    body.external_url, body.status || 'active'
  );

  const row = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  sendJSON(res, 201, { campaign: rowToCampaign(row) });
}

async function updateCampaign(req, res, id) {
  const username = requireAdmin(req);
  if (!username) return sendJSON(res, 401, { error: 'Unauthorized' });

  const existing = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  if (!existing) return sendJSON(res, 404, { error: 'Campaign not found' });

  const body = await readBody(req);
  const merged = {
    student_name: body.student_name ?? existing.student_name,
    title: body.title ?? existing.title,
    story: body.story ?? existing.story,
    field: body.field ?? existing.field,
    goal_amount: body.goal_amount != null ? Math.round(body.goal_amount) : existing.goal_amount,
    raised_amount: body.raised_amount != null ? Math.round(body.raised_amount) : existing.raised_amount,
    external_url: body.external_url ?? existing.external_url,
    status: body.status ?? existing.status
  };

  db.prepare(`
    UPDATE campaigns SET student_name=?, title=?, story=?, field=?, goal_amount=?, raised_amount=?, external_url=?, status=?
    WHERE id=?
  `).run(merged.student_name, merged.title, merged.story, merged.field, merged.goal_amount, merged.raised_amount, merged.external_url, merged.status, id);

  const row = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  sendJSON(res, 200, { campaign: rowToCampaign(row) });
}

async function deleteCampaign(req, res, id) {
  const username = requireAdmin(req);
  if (!username) return sendJSON(res, 401, { error: 'Unauthorized' });

  const existing = db.prepare('SELECT id FROM campaigns WHERE id = ?').get(id);
  if (!existing) return sendJSON(res, 404, { error: 'Campaign not found' });

  db.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
  sendJSON(res, 200, { deleted: id });
}

// ---------- AI letter assistant ----------
async function letterAssistant(req, res) {
  const body = await readBody(req);
  const name = (body.name || '').trim();
  const points = (body.points || '').trim();

  if (!name || !points) {
    return sendJSON(res, 400, { error: 'name and points are required' });
  }
  if (!GEMINI_API_KEY) {
    return sendJSON(res, 503, { error: 'Fundisa AI is not configured on this server. Add GEMINI_API_KEY to the backend environment and restart the server.' });
  }

  const fieldOfStudy = (body.fieldOfStudy || '').trim();
  const targetBursary = (body.targetBursary || '').trim();

  const systemPrompt = `You help South African students draft motivational letters for bursary applications, for the Fundisa website. You will be given the student's name and a set of facts, achievements, and circumstances they've told you about themselves. Write a warm, honest, well-structured first-draft motivational letter (roughly 300-450 words) in the student's voice.

Strict rules:
- Use ONLY the facts, achievements, and circumstances the student actually provided. Never invent grades, awards, financial details, or experiences they didn't mention.
- Do not exaggerate or embellish beyond what was stated.
- Write in first person, as a draft the student will personalize and verify before submitting - not a finished, submission-ready letter.
- Keep the tone genuine and specific rather than generic or flowery.

Respond ONLY with raw JSON (no markdown fences, no preamble) in exactly this shape:
{"letter":"<the drafted letter as plain text with \\n for paragraph breaks>"}`;

  const userMessage = `Student name: ${name}
Field of study: ${fieldOfStudy || 'not specified'}
Target bursary/programme: ${targetBursary || 'not specified'}
Facts, achievements, and circumstances the student provided:
${points}`;

  try {
    // Use the same modern Gemini request path as the other AI features.
    // JSON mode is enabled so the response is predictable and easy to parse.
    const result = await callGeminiText(systemPrompt, userMessage, { maxOutputTokens: 1200, json: true });
    const cleaned = String(result.text || '').trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // Some model responses can contain a valid JSON object inside surrounding text.
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start < 0 || end <= start) throw new Error('The AI returned an unreadable response.');
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    }
    if (!parsed.letter || typeof parsed.letter !== 'string') throw new Error('The AI returned no motivational letter.');
    sendJSON(res, 200, { letter: parsed.letter });
  } catch (err) {
    console.error('Letter assistant error:', err);
    const message = String(err?.message || 'AI request failed');
    if (/GEMINI_API_KEY is not configured/i.test(message)) {
      return sendJSON(res, 503, { error: 'The AI letter assistant is not configured yet. Add GEMINI_API_KEY to the backend environment.' });
    }
    if (/Gemini API error 429/i.test(message)) {
      return sendJSON(res, 429, { error: 'The AI service is temporarily busy. Please wait a moment and try again.' });
    }
    sendJSON(res, 502, { error: 'The AI letter assistant could not respond right now. Please try again.' });
  }
}


function isoToday() { return new Date().toISOString().slice(0, 10); }

async function verifySingleBursary(bursary) {
  const year = new Date().getFullYear();
  const sourceHint = bursary.url ? ` Existing source URL: ${bursary.url}` : '';
  const prompt = `You are a bursary data verification agent for Fundisa, a South African student platform. Check the current ${year} application status for exactly this bursary: ${bursary.name}, provider ${bursary.provider}. Search the public web, prioritizing the provider's official website and official application pages.${sourceHint}\n\nReturn ONLY JSON with these keys: verifiable (boolean), current (boolean), status (one of open, upcoming, closed, unknown), deadline_text (string), deadline_date (YYYY-MM-DD or null), official_url (string or empty), confidence (number 0 to 1), notes (short string).\n\nRules: if you cannot find reliable current evidence, verifiable=false and do not claim it is closed. current=false only when you have strong evidence the relevant application is closed/expired. Do not infer a deadline from an old article. Do not invent URLs or dates.`;
  const result = await callGeminiText(prompt, `Verify this bursary record: ${JSON.stringify({ name:bursary.name, provider:bursary.provider, deadline:bursary.deadline, deadline_date:bursary.deadline_date, url:bursary.url, fields:bursary.fields })}`, { googleSearch: true, maxOutputTokens: 800, json: true });
  const cleaned = result.text.trim().replace(/^```json/, '').replace(/^```/, '').replace(/```$/, '').trim();
  const parsed = JSON.parse(cleaned);
  return { ...parsed, sources: groundingSources(result.groundingMetadata) };
}

async function findReplacementCandidate(fields) {
  const year = new Date().getFullYear();
  const prompt = `Find one real, currently open South African bursary for ${year} that fits at least one of these fields: ${fields.join(', ')}. Search the web and prioritize an official provider or government application page. Return ONLY JSON: {found:boolean,name:string,provider:string,fields:string[],description:string,eligibility:string,deadline:string,deadline_date:string|null,official_url:string,confidence:number,notes:string}. If you cannot verify a real current opportunity with a trustworthy URL and future/current deadline, return found=false. Never invent a bursary.`;
  const result = await callGeminiText(prompt, 'Find a verified replacement bursary.', { googleSearch: true, maxOutputTokens: 900, json: true });
  const cleaned = result.text.trim().replace(/^```json/, '').replace(/^```/, '').replace(/```$/, '').trim();
  const parsed = JSON.parse(cleaned);
  return { ...parsed, sources: groundingSources(result.groundingMetadata) };
}

async function maybeReplaceBursary(bursary) {
  if (!AUTO_REPLACE_OUTDATED) return null;
  const today = isoToday();
  const replacement = await findReplacementCandidate(bursary.fields || []);
  const validDate = !replacement.deadline_date || replacement.deadline_date >= today;
  const validUrl = /^https?:\/\//i.test(replacement.official_url || '');
  if (!replacement.found || Number(replacement.confidence) < 0.90 || !validUrl || !validDate) return null;

  const newId = `${replacement.name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48) + '-' + randomBytes(3).toString('hex');
  db.prepare(`INSERT INTO bursaries (id,name,provider,fields,description,eligibility,deadline,deadline_date,status,url,source_url,last_verified_at,verification_status,verification_notes,verification_confidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    newId, replacement.name, replacement.provider, JSON.stringify(replacement.fields || bursary.fields || []), replacement.description || '', replacement.eligibility || '', replacement.deadline || 'Check official site', replacement.deadline_date || null, 'open', replacement.official_url, replacement.official_url, new Date().toISOString(), 'verified', replacement.notes || '', Number(replacement.confidence)
  );
  const inserted = db.prepare('SELECT * FROM bursaries WHERE id=?').get(newId);
  void notifySubscribersAboutBursary(rowToBursary(inserted), 'new');
  return { id: newId, name: replacement.name, sources: replacement.sources || [] };
}

async function checkBursaryFreshness(req, res) {
  const admin = requireAdmin(req);
  const monitorAuthorized = !!MONITOR_SECRET && req.headers['x-monitor-secret'] === MONITOR_SECRET;
  if (!admin && !monitorAuthorized) return sendJSON(res, 401, { error: 'Unauthorized' });
  const requestedLimit = Number(new URL(req.url, `http://${req.headers.host}`).searchParams.get('limit') || 0);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 0;
  const rows = limit
    ? db.prepare(`SELECT * FROM bursaries ORDER BY COALESCE(last_verified_at, '1970-01-01T00:00:00.000Z') ASC LIMIT ${limit}`).all()
    : db.prepare('SELECT * FROM bursaries ORDER BY created_at ASC').all();
  const results = [];
  const today = isoToday();
  for (const raw of rows) {
    const b = rowToBursary(raw);
    if (raw.status === 'closed') {
      results.push({ id: raw.id, name: raw.name, action: 'skipped_closed' });
      continue;
    }
    try {
      // Deterministic expiry check first when an exact deadline date exists.
      if (raw.deadline_date && raw.deadline_date < today) {
        db.prepare("UPDATE bursaries SET status='closed', verification_status='expired_by_deadline', last_verified_at=datetime('now'), verification_confidence=1, verification_notes=? WHERE id=?").run(`Deadline date ${raw.deadline_date} has passed.`, raw.id);
        let replacement = null;
        try { replacement = await maybeReplaceBursary(b); } catch (replacementErr) { console.error('Replacement search error:', replacementErr.message); }
        results.push({ id: raw.id, name: raw.name, action: replacement ? `closed;replaced_with:${replacement.id}` : 'closed', reason: 'deadline_date passed' });
        continue;
      }
      const verification = await verifySingleBursary(b);
      db.prepare(`UPDATE bursaries SET status=?, deadline=?, deadline_date=?, url=?, source_url=?, last_verified_at=datetime('now'), verification_status=?, verification_notes=?, verification_confidence=? WHERE id=?`).run(
        verification.verifiable && ['open','upcoming','closed'].includes(verification.status) ? verification.status : raw.status,
        verification.deadline_text || raw.deadline,
        verification.deadline_date || raw.deadline_date,
        verification.official_url || raw.url,
        verification.official_url || raw.source_url || raw.url,
        verification.verifiable ? 'verified' : 'needs_review',
        verification.notes || (verification.sources?.map(s => s.url).join(', ') || ''),
        Number.isFinite(Number(verification.confidence)) ? Number(verification.confidence) : null,
        raw.id
      );
      let action = verification.verifiable ? `status:${verification.status}` : 'needs_review';
      if (verification.verifiable && verification.current === false && Number(verification.confidence) >= 0.85) {
        db.prepare("UPDATE bursaries SET status='closed' WHERE id=?").run(raw.id);
        action = 'closed_by_verification';
        if (AUTO_REPLACE_OUTDATED) {
          try {
            const replacement = await maybeReplaceBursary(b);
            if (replacement) action += `;replaced_with:${replacement.id}`;
          } catch (replacementErr) {
            console.error('Replacement search error:', replacementErr.message);
          }
        }
      }
      results.push({ id: raw.id, name: raw.name, action, confidence: verification.confidence, sources: verification.sources || [] });
    } catch (err) {
      console.error(`Freshness check failed for ${raw.name}:`, err.message);
      db.prepare("UPDATE bursaries SET verification_status='needs_review', last_verified_at=datetime('now'), verification_notes=? WHERE id=?").run(err.message, raw.id);
      results.push({ id: raw.id, name: raw.name, action: 'error', error: err.message });
    }
  }
  sendJSON(res, 200, { checkedAt: new Date().toISOString(), results });
}

// ---------- router ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname, searchParams } = url;
  const { method } = req;
  const origin = allowedOrigin(req);
  res.__fundisaOrigin = origin;
  if (req.headers.origin && !origin) return sendJSON(res, 403, { error: 'Origin not allowed.' });
  if (method === 'OPTIONS') {
    res.writeHead(204, { ...(origin ? {'Access-Control-Allow-Origin':origin,'Vary':'Origin'} : {}), 'Access-Control-Allow-Headers':'Content-Type, Authorization, X-Monitor-Secret', 'Access-Control-Allow-Methods':'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Max-Age':'600' });
    return res.end();
  }
  const rateBucket = (pathname.startsWith('/api/auth/') || pathname === '/api/admin/login') ? 'auth' : (['/api/assistant','/api/chat','/api/letter-assistant','/api/student/copilot'].includes(pathname) ? 'ai' : 'public');
  if (!rateLimit(req, res, rateBucket)) return;

  try {
    if (pathname === '/api/health' && method === 'GET') return sendJSON(res, 200, { ok: true });
    if (pathname === '/api/bursaries' && method === 'GET') return await listBursaries(req, res, searchParams);
    if (pathname === '/api/bursaries' && method === 'POST') return await createBursary(req, res);
    if (pathname === '/api/fields' && method === 'GET') return await listFields(req, res);
    if (pathname === '/api/notify' && method === 'POST') return await subscribe(req, res);
    if (pathname === '/api/notify' && method === 'GET') return await listSubscribers(req, res);
    if (pathname === '/api/notify/unsubscribe' && method === 'GET') return await unsubscribe(req, res, searchParams);
    if (pathname === '/api/admin/login' && method === 'POST') return await adminLogin(req, res);
    if (pathname === '/api/auth/register' && method === 'POST') return await studentAuth(req, res, 'register');
    if (pathname === '/api/auth/login' && method === 'POST') return await studentAuth(req, res, 'login');
    if (pathname === '/api/auth/me' && method === 'GET') return await getStudentProfile(req, res);
    if (pathname === '/api/auth/profile' && method === 'PUT') return await updateStudentProfile(req, res);
    if (pathname === '/api/student/notification-settings' && method === 'GET') return await getStudentNotificationSettings(req,res);
    if (pathname === '/api/student/notification-settings' && method === 'PUT') return await updateStudentNotificationSettings(req,res);
    if (pathname === '/api/student/notifications' && method === 'GET') return await listStudentNotifications(req,res);
    if (pathname === '/api/student/notifications/read' && method === 'POST') return await markStudentNotificationsRead(req,res);
    if (pathname === '/api/student/copilot' && method === 'GET') return await getStudentCopilot(req,res);
    if (pathname === '/api/student/application-readiness' && method === 'GET') return await getApplicationReadiness(req,res);
    if (pathname === '/api/student/application-readiness' && method === 'PUT') return await updateApplicationReadiness(req,res);
    if (pathname === '/api/maintenance/notification-sweep' && method === 'POST') return await runNotificationSweep(req,res);
    if (pathname === '/api/auth/logout' && method === 'POST') return await studentLogout(req, res);
    if (pathname === '/api/student/saved' && method === 'GET') return await listStudentSaved(req, res);
    if (pathname === '/api/student/saved' && method === 'POST') return await saveStudentBursary(req, res);
    const savedMatch = pathname.match(/^\/api\/student\/saved\/([^/]+)$/);
    if (savedMatch && method === 'DELETE') return await deleteStudentBursary(req, res);
    if (pathname === '/api/assistant' && method === 'POST') return await aiAssistant(req, res);
    if (pathname === '/api/chat' && method === 'POST') return await chatAssistant(req, res);
    if (pathname === '/api/maintenance/check-bursaries' && method === 'POST') return await checkBursaryFreshness(req, res);
    if (pathname === '/api/maintenance/sync-bursaries' && method === 'POST') return await syncBursarySources(req, res);
    if (pathname === '/api/letter-assistant' && method === 'POST') return await letterAssistant(req, res);
    if (pathname === '/api/campaigns' && method === 'GET') return await listCampaigns(req, res);
    if (pathname === '/api/campaigns' && method === 'POST') return await createCampaign(req, res);

    const bursaryMatch = pathname.match(/^\/api\/bursaries\/([\w-]+)$/);
    if (bursaryMatch && method === 'PUT') return await updateBursary(req, res, bursaryMatch[1]);
    if (bursaryMatch && method === 'DELETE') return await deleteBursary(req, res, bursaryMatch[1]);

    const campaignMatch = pathname.match(/^\/api\/campaigns\/([\w-]+)$/);
    if (campaignMatch && method === 'PUT') return await updateCampaign(req, res, campaignMatch[1]);
    if (campaignMatch && method === 'DELETE') return await deleteCampaign(req, res, campaignMatch[1]);

    if (method === 'GET' && await serveFrontend(pathname, res)) return;
    sendJSON(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('Request error:', err);
    sendJSON(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Fundisa backend running on http://localhost:${PORT}`);
  console.log(`Admin login: ${ADMIN_USERNAME} / (password from .env)`);
});
