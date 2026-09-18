import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configuredPath = String(process.env.FUNDISA_DB_PATH || '').trim();
const dbPath = configuredPath || join(__dirname, 'data', 'fundisa.db');
const dataDir = dirname(dbPath);
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;`);

db.exec(`
  CREATE TABLE IF NOT EXISTS bursaries (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    fields TEXT NOT NULL,
    description TEXT,
    eligibility TEXT,
    deadline TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    url TEXT,
    source_url TEXT,
    source_type TEXT NOT NULL DEFAULT 'manual',
    source_id TEXT,
    last_source_sync_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    field TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    confirmed_at TEXT,
    unsubscribe_token TEXT UNIQUE,
    last_notified_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    institution TEXT,
    study_field TEXT,
    study_year TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS student_sessions (
    token TEXT PRIMARY KEY,
    student_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS saved_bursaries (
    student_id INTEGER NOT NULL,
    bursary_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Saved',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(student_id, bursary_id),
    FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS notification_preferences (
    student_id INTEGER PRIMARY KEY,
    email_deadlines INTEGER NOT NULL DEFAULT 1,
    email_new_matches INTEGER NOT NULL DEFAULT 1,
    email_updates INTEGER NOT NULL DEFAULT 1,
    reminder_days TEXT NOT NULL DEFAULT '[14,7,3,1]',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS student_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    bursary_id TEXT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(student_id, bursary_id, type),
    FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS application_checklist_items (
    student_id INTEGER NOT NULL,
    bursary_id TEXT NOT NULL,
    task_key TEXT NOT NULL,
    label TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(student_id, bursary_id, task_key),
    FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
    FOREIGN KEY(bursary_id) REFERENCES bursaries(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    student_name TEXT NOT NULL,
    title TEXT NOT NULL,
    story TEXT NOT NULL,
    field TEXT,
    goal_amount INTEGER NOT NULL,
    raised_amount INTEGER NOT NULL DEFAULT 0,
    external_url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ---- seed bursaries on first run only ----
const SEED_BURSARIES = [
  { id:'nsfas', name:'NSFAS', provider:'National Student Financial Aid Scheme (Government)', fields:['All fields'], description:'Covers tuition, accommodation, meals, transport, learning materials and a personal care allowance at public universities and TVET colleges.', eligibility:'SA citizens with household income ≤ R350,000/year (R600,000 for students with disabilities or from SASSA-grant households).', deadline:'2027 applications expected to open Sep-Nov 2026', status:'upcoming', url:'https://www.nsfas.org.za' },
  { id:'sappi', name:'Sappi Bursary', provider:'Sappi', fields:['Engineering','Forestry & Built Environment'], description:'Undergraduate bursary for students in engineering and forestry science.', eligibility:'See official site for full academic criteria.', deadline:'Closes 30 September 2026', status:'open', url:'https://fundiconnect.co.za/bursaries-2027' },
  { id:'idc', name:'IDC External Bursary', provider:'Industrial Development Corporation', fields:['STEM','Commerce & Finance','Law'], description:'Development-finance bursary supporting students across STEM, commerce and law.', eligibility:'See official site for full academic criteria.', deadline:'Closes 30 September 2026', status:'open', url:'https://fundiconnect.co.za/bursaries-2027' },
  { id:'treasury', name:'National Treasury Bursary Scheme', provider:'National Treasury', fields:['Commerce & Finance','Law'], description:'Supports high-performing students in accounting, economics, finance and law - fields the Treasury considers critical and scarce.', eligibility:'SA citizens, strong academic record, studying an eligible field, entering an eligible level of study in 2027.', deadline:'Closes 30 September 2026, 12:00 PM', status:'open', url:'https://www.opportunitiesforafricans.com/the-national-treasury-bursary-scheme-2027-for-young-south-african-students/' },
  { id:'sasol', name:'Sasol Bursary Programme', provider:'Sasol', fields:['STEM','Mining & Built Environment'], description:'Comprehensive funding plus professional development for STEM and mining-aligned studies, with several programmes opening on a rolling basis.', eligibility:'See official site - different programmes have different criteria.', deadline:'Programmes opening Aug-Sep 2026, dates vary by programme', status:'open', url:'https://www.globalsouthopportunities.com/2026/08/06/sasol-4/' },
  { id:'isfap', name:'ISFAP Bursary', provider:'Ikusasa Student Financial Aid Programme', fields:['All fields'], description:'Multi-partner funding programme for financially and academically deserving students (the "missing middle").', eligibility:'See official site for income and academic thresholds.', deadline:'Open - check official site for current intake', status:'open', url:'https://ibursaries.co.za/' },
  { id:'bbd', name:'BBD Software Development Bursary', provider:'BBD (SA26 intake)', fields:['IT & Computer Science'], description:'Funding, mentorship and real-world coding experience for aspiring software developers.', eligibility:'See official site for full academic criteria.', deadline:'Open all year round', status:'open', url:'https://ibursaries.co.za/' },
  { id:'masakh', name:"Masakh'iSizwe Bursary", provider:"Masakh'iSizwe", fields:['Engineering','Mining & Built Environment'], description:'Full-cost funding for engineering and built-environment students, with a work-back contract after graduation.', eligibility:'See official site for full academic criteria.', deadline:'Check official site for current intake', status:'open', url:'https://ibursaries.co.za/' },
  { id:'allangray', name:'Allan Gray Orbis Foundation Fellowship', provider:'Allan Gray Orbis Foundation', fields:['Entrepreneurship','All fields'], description:'Fellowship for entrepreneurially minded students at partner universities, regardless of degree field.', eligibility:'See official site for full academic criteria.', deadline:'Check official site for current intake', status:'open', url:'https://fundiconnect.co.za/bursaries-2027' },
  { id:'anglo', name:'Anglo American Bursary', provider:'Anglo American', fields:['Engineering','Mining & Built Environment'], description:'Funds engineering and mining studies in exchange for a work-back obligation after graduation.', eligibility:'See official site for full academic criteria.', deadline:'Check official site for current intake', status:'open', url:'https://fundiconnect.co.za/bursaries-2027' }
];

const count = db.prepare('SELECT COUNT(*) AS n FROM bursaries').get().n;
if (count === 0) {
  const insert = db.prepare(`
    INSERT INTO bursaries (id, name, provider, fields, description, eligibility, deadline, status, url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const b of SEED_BURSARIES) {
    insert.run(b.id, b.name, b.provider, JSON.stringify(b.fields), b.description, b.eligibility, b.deadline, b.status, b.url);
  }
  console.log(`Seeded ${SEED_BURSARIES.length} bursaries.`);
}

// ---- safe migration: add deadline_date without touching existing rows ----
// Runs every startup; a no-op once the column already exists. Needed because
// CREATE TABLE IF NOT EXISTS above does nothing on a database that was
// already created before this column existed - this is what actually adds
// it to an already-live database without losing any data.
const bursaryColumns = db.prepare("PRAGMA table_info(bursaries)").all().map(c => c.name);
if (!bursaryColumns.includes('deadline_date')) {
  db.exec('ALTER TABLE bursaries ADD COLUMN deadline_date TEXT');
  console.log('Migrated: added deadline_date column to bursaries.');
}

// Subscriber migrations - safe for databases created by older Fundisa versions.
const subscriberColumns = db.prepare("PRAGMA table_info(subscribers)").all().map(c => c.name);
if (!subscriberColumns.includes('active')) db.exec('ALTER TABLE subscribers ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
if (!subscriberColumns.includes('confirmed_at')) db.exec('ALTER TABLE subscribers ADD COLUMN confirmed_at TEXT');
if (!subscriberColumns.includes('unsubscribe_token')) db.exec('ALTER TABLE subscribers ADD COLUMN unsubscribe_token TEXT');
if (!subscriberColumns.includes('last_notified_at')) db.exec('ALTER TABLE subscribers ADD COLUMN last_notified_at TEXT');

const verificationColumns = db.prepare("PRAGMA table_info(bursaries)").all().map(c => c.name);
if (!verificationColumns.includes('last_verified_at')) db.exec('ALTER TABLE bursaries ADD COLUMN last_verified_at TEXT');
if (!verificationColumns.includes('verification_status')) db.exec("ALTER TABLE bursaries ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'unverified'");
if (!verificationColumns.includes('verification_notes')) db.exec('ALTER TABLE bursaries ADD COLUMN verification_notes TEXT');
if (!verificationColumns.includes('verification_confidence')) db.exec('ALTER TABLE bursaries ADD COLUMN verification_confidence REAL');
if (!verificationColumns.includes('source_url')) db.exec('ALTER TABLE bursaries ADD COLUMN source_url TEXT');
if (!verificationColumns.includes('source_type')) db.exec("ALTER TABLE bursaries ADD COLUMN source_type TEXT NOT NULL DEFAULT 'manual'");
if (!verificationColumns.includes('source_id')) db.exec('ALTER TABLE bursaries ADD COLUMN source_id TEXT');
if (!verificationColumns.includes('last_source_sync_at')) db.exec('ALTER TABLE bursaries ADD COLUMN last_source_sync_at TEXT');

// Existing bursaries are Fundisa-curated unless explicitly imported from an external source.
db.prepare("UPDATE bursaries SET source_type='manual' WHERE source_type IS NULL OR source_type=''").run();

// Fill newly added source_url from the existing official/source URL field.
db.prepare("UPDATE bursaries SET source_url = url WHERE (source_url IS NULL OR source_url = '') AND url IS NOT NULL AND url <> ''").run();

export function ensureUnsubscribeToken(email) {
  const existing = db.prepare('SELECT unsubscribe_token FROM subscribers WHERE lower(email)=lower(?)').get(email);
  if (existing?.unsubscribe_token) return existing.unsubscribe_token;
  return null;
}

// Unique email index for idempotent newsletter signups. Ignore duplicates from old data by deduping first.
const duplicateRows = db.prepare("SELECT lower(email) AS normalized, MIN(id) AS keep_id, COUNT(*) AS n FROM subscribers GROUP BY lower(email) HAVING COUNT(*) > 1").all();
for (const d of duplicateRows) db.prepare('DELETE FROM subscribers WHERE lower(email)=? AND id<>?').run(d.normalized, d.keep_id);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_subscribers_email_unique ON subscribers(lower(email))');

export default db;
