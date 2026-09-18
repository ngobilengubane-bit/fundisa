import { randomBytes } from 'node:crypto';
import db from './db.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

// Fundisa's first version uses public/official web sources instead of a paid
// bursary API. This list is deliberately small and can grow over time.
const PUBLIC_SOURCES = [
  { name: 'NSFAS', domains: ['nsfas.org.za'] },
  { name: 'South African Department of Higher Education and Training', domains: ['dhet.gov.za', 'education.gov.za'] },
  { name: 'Funza Lushaka', domains: ['education.gov.za'] },
  { name: 'Sappi', domains: ['sappi.com'] },
  { name: 'Sasol', domains: ['sasol.com'] },
  { name: 'Anglo American', domains: ['angloamerican.com'] },
  { name: 'Eskom', domains: ['eskom.co.za'] },
  { name: 'Industrial Development Corporation', domains: ['idc.co.za'] }
];

function normalize(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function safeJSON(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function cleanFields(fields) {
  const arr = Array.isArray(fields) ? fields : String(fields || '').split(',');
  const cleaned = arr.map(v => String(v).trim()).filter(Boolean).slice(0, 8);
  return cleaned.length ? cleaned : ['All fields'];
}

function isAllowedOfficialUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return PUBLIC_SOURCES.some(source => source.domains.some(domain => host === domain || host.endsWith(`.${domain}`)));
  } catch { return false; }
}

function mapDiscoveredBursary(item) {
  const name = String(item?.name || '').trim();
  const provider = String(item?.provider || '').trim();
  const officialUrl = String(item?.official_url || item?.url || '').trim();
  const deadlineDate = String(item?.deadline_date || '').trim() || null;
  const deadline = String(item?.deadline || '').trim() || 'Check the official provider site';
  const status = ['open', 'upcoming', 'closed'].includes(String(item?.status || '').toLowerCase())
    ? String(item.status).toLowerCase()
    : 'open';

  if (!name || !provider || !officialUrl || !/^https:\/\//i.test(officialUrl) || !isAllowedOfficialUrl(officialUrl)) return null;

  return {
    name,
    provider,
    fields: cleanFields(item?.fields),
    description: String(item?.description || '').trim(),
    eligibility: String(item?.eligibility || '').trim(),
    deadline,
    deadlineDate,
    status,
    url: officialUrl,
    sourceUrl: officialUrl,
    confidence: Number(item?.confidence || 0),
    notes: String(item?.notes || '').trim()
  };
}

async function discoverFromPublicSources() {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured. Public source discovery uses the Gemini free/available API access already used by Fundisa.');

  const year = new Date().getFullYear();
  const sourceText = PUBLIC_SOURCES.map(s => `${s.name}: ${s.domains.join(', ')}`).join('\n');
  const prompt = `Find real South African bursary and scholarship opportunities for the ${year} application cycle using public web information. Prioritize the official provider domains listed below. Only include opportunities that you can verify from a trustworthy current source. Do not invent names, deadlines, eligibility, URLs, or funding details.

OFFICIAL SOURCE PRIORITY:
${sourceText}

Return ONLY valid JSON in exactly this shape:
{"bursaries":[{"name":"...","provider":"...","fields":["..."],"description":"...","eligibility":"...","deadline":"...","deadline_date":"YYYY-MM-DD or null","status":"open|upcoming|closed","official_url":"https://...","confidence":0.0,"notes":"..."}]}

Rules:
- Use HTTPS URLs only.
- Use a direct official provider page. The URL must belong to one of the listed official provider domains. Never return a blog or aggregator URL.
- If a deadline is not confirmed, say "Check the official provider site" and use null for deadline_date.
- Do not label an opportunity open unless current evidence supports that status.
- It is acceptable to return fewer results rather than uncertain results.
- Return up to 20 strong records.`;

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: 'You are Fundisa public bursary source discovery agent. Accuracy matters more than quantity. Never invent bursaries.' }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 5000 }
    })
  });

  if (!response.ok) throw new Error(`Gemini public-source discovery error ${response.status}: ${await response.text()}`);
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.find(p => p.text)?.text;
  if (!text) throw new Error('Gemini returned no public bursary data.');

  const parsed = safeJSON(text, null);
  if (!parsed || !Array.isArray(parsed.bursaries)) throw new Error('Public source discovery returned invalid JSON.');

  return parsed.bursaries.map(mapDiscoveredBursary).filter(Boolean);
}

export async function syncPublicBursarySources() {
  const discovered = await discoverFromPublicSources();
  const imported = [];
  const updated = [];
  const skipped = [];

  const existing = db.prepare('SELECT * FROM bursaries').all();
  const byNameProvider = new Map(existing.map(row => [`${normalize(row.name)}|${normalize(row.provider)}`, row]));

  for (const item of discovered) {
    const key = `${normalize(item.name)}|${normalize(item.provider)}`;
    const row = byNameProvider.get(key);

    if (row) {
      const newFields = JSON.stringify(item.fields);
      const materiallyChanged = [
        row.fields !== newFields,
        (row.description || '') !== item.description,
        (row.eligibility || '') !== item.eligibility,
        (row.deadline || '') !== item.deadline,
        (row.deadline_date || null) !== item.deadlineDate,
        (row.status || '') !== item.status,
        (row.url || '') !== item.url
      ].some(Boolean);

      db.prepare(`UPDATE bursaries SET fields=?, description=?, eligibility=?, deadline=?, deadline_date=?, status=?, url=?, source_url=?, source_type='public_web', source_id=?, last_source_sync_at=datetime('now'), verification_status=?, verification_notes=?, verification_confidence=? WHERE id=?`).run(
        newFields, item.description, item.eligibility, item.deadline, item.deadlineDate,
        item.status, item.url, item.sourceUrl, `public:${normalize(item.provider)}:${normalize(item.name)}`,
        item.confidence >= 0.8 ? 'verified_candidate' : 'needs_review', item.notes, item.confidence || null, row.id
      );
      updated.push({ id: row.id, name: item.name, materiallyChanged });
      continue;
    }

    const id = `public-${normalize(item.provider).replace(/\s+/g, '-').slice(0, 24)}-${normalize(item.name).replace(/\s+/g, '-').slice(0, 32)}-${randomBytes(3).toString('hex')}`;
    db.prepare(`INSERT INTO bursaries (id,name,provider,fields,description,eligibility,deadline,deadline_date,status,url,source_url,source_type,source_id,last_source_sync_at,verification_status,verification_notes,verification_confidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, item.name, item.provider, JSON.stringify(item.fields), item.description, item.eligibility,
      item.deadline, item.deadlineDate, item.status, item.url, item.sourceUrl, 'public_web',
      `public:${normalize(item.provider)}:${normalize(item.name)}`, new Date().toISOString(),
      item.confidence >= 0.8 ? 'verified_candidate' : 'needs_review', item.notes, item.confidence || null
    );
    imported.push({ id, name: item.name });
    byNameProvider.set(key, { id });
  }

  return {
    source: 'Fundisa public/official web sources',
    sourceCount: PUBLIC_SOURCES.length,
    discovered: discovered.length,
    imported: imported.length,
    updated: updated.length,
    skipped: skipped.length,
    importedItems: imported,
    updatedItems: updated,
    sources: PUBLIC_SOURCES,
    syncedAt: new Date().toISOString()
  };
}
