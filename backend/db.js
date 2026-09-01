import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, 'data');
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, 'fundisa.db'));

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
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    field TEXT,
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
`);

// ---- seed bursaries on first run only ----
const SEED_BURSARIES = [
  { id:'nsfas', name:'NSFAS', provider:'National Student Financial Aid Scheme (Government)', fields:['All fields'], description:'Covers tuition, accommodation, meals, transport, learning materials and a personal care allowance at public universities and TVET colleges.', eligibility:'SA citizens with household income ≤ R350,000/year (R600,000 for students with disabilities or from SASSA-grant households).', deadline:'2027 applications expected to open Sep–Nov 2026', status:'upcoming', url:'https://www.nsfas.org.za' },
  { id:'sappi', name:'Sappi Bursary', provider:'Sappi', fields:['Engineering','Forestry & Built Environment'], description:'Undergraduate bursary for students in engineering and forestry science.', eligibility:'See official site for full academic criteria.', deadline:'Closes 30 September 2026', status:'open', url:'https://fundiconnect.co.za/bursaries-2027' },
  { id:'idc', name:'IDC External Bursary', provider:'Industrial Development Corporation', fields:['STEM','Commerce & Finance','Law'], description:'Development-finance bursary supporting students across STEM, commerce and law.', eligibility:'See official site for full academic criteria.', deadline:'Closes 30 September 2026', status:'open', url:'https://fundiconnect.co.za/bursaries-2027' },
  { id:'treasury', name:'National Treasury Bursary Scheme', provider:'National Treasury', fields:['Commerce & Finance','Law'], description:'Supports high-performing students in accounting, economics, finance and law — fields the Treasury considers critical and scarce.', eligibility:'SA citizens, strong academic record, studying an eligible field, entering an eligible level of study in 2027.', deadline:'Closes 30 September 2026, 12:00 PM', status:'open', url:'https://www.opportunitiesforafricans.com/the-national-treasury-bursary-scheme-2027-for-young-south-african-students/' },
  { id:'sasol', name:'Sasol Bursary Programme', provider:'Sasol', fields:['STEM','Mining & Built Environment'], description:'Comprehensive funding plus professional development for STEM and mining-aligned studies, with several programmes opening on a rolling basis.', eligibility:'See official site — different programmes have different criteria.', deadline:'Programmes opening Aug–Sep 2026, dates vary by programme', status:'open', url:'https://www.globalsouthopportunities.com/2026/08/06/sasol-4/' },
  { id:'isfap', name:'ISFAP Bursary', provider:'Ikusasa Student Financial Aid Programme', fields:['All fields'], description:'Multi-partner funding programme for financially and academically deserving students (the "missing middle").', eligibility:'See official site for income and academic thresholds.', deadline:'Open — check official site for current intake', status:'open', url:'https://ibursaries.co.za/' },
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

export default db;
