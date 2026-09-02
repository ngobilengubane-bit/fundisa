import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import db from './db.js';
import { ensureAdmin, login, requireAdmin } from './auth.js';

const PORT = process.env.PORT || 3001;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'nqobile';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';

ensureAdmin(ADMIN_USERNAME, ADMIN_PASSWORD);

// ---------- helpers ----------
function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy(); // basic guard against huge payloads
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function rowToBursary(row) {
  return { ...row, fields: JSON.parse(row.fields) };
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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
    INSERT INTO bursaries (id, name, provider, fields, description, eligibility, deadline, status, url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, body.name, body.provider, JSON.stringify(body.fields),
    body.description || '', body.eligibility || '', body.deadline,
    body.status || 'open', body.url || ''
  );

  const row = db.prepare('SELECT * FROM bursaries WHERE id = ?').get(id);
  sendJSON(res, 201, { bursary: rowToBursary(row) });
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
    status: body.status ?? existing.status,
    url: body.url ?? existing.url
  };

  db.prepare(`
    UPDATE bursaries SET name=?, provider=?, fields=?, description=?, eligibility=?, deadline=?, status=?, url=?
    WHERE id=?
  `).run(merged.name, merged.provider, merged.fields, merged.description, merged.eligibility, merged.deadline, merged.status, merged.url, id);

  const row = db.prepare('SELECT * FROM bursaries WHERE id = ?').get(id);
  sendJSON(res, 200, { bursary: rowToBursary(row) });
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
  if (!isValidEmail(body.email)) return sendJSON(res, 400, { error: 'Valid email required' });

  db.prepare('INSERT INTO subscribers (email, field) VALUES (?, ?)').run(body.email, body.field || 'Any field');
  sendJSON(res, 201, { subscribed: true });
}

async function listSubscribers(req, res) {
  const username = requireAdmin(req);
  if (!username) return sendJSON(res, 401, { error: 'Unauthorized' });

  const rows = db.prepare('SELECT id, email, field, created_at FROM subscribers ORDER BY created_at DESC').all();
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

  if (!ANTHROPIC_API_KEY) {
    return sendJSON(res, 500, { error: 'Server is missing ANTHROPIC_API_KEY. Set it in your .env file.' });
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
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Student's field of study: ${query}` }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return sendJSON(res, 502, { error: 'The AI assistant is unavailable right now.' });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock) return sendJSON(res, 502, { error: 'Unexpected response from AI assistant.' });

    const cleaned = textBlock.text.trim().replace(/^```json/, '').replace(/^```/, '').replace(/```$/, '').trim();
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

// ---------- campaigns (student fundraisers) ----------
// Fundisa never touches the money. Every campaign links out to wherever
// the student's real donation page already lives (BackaBuddy, GoFundMe,
// a bank EFT page, etc). goal_amount / raised_amount are self-reported
// by the student and kept current by an admin — there's no live payment
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
  if (!ANTHROPIC_API_KEY) {
    return sendJSON(res, 500, { error: 'Server is missing ANTHROPIC_API_KEY. Set it in your .env file.' });
  }

  const fieldOfStudy = (body.fieldOfStudy || '').trim();
  const targetBursary = (body.targetBursary || '').trim();

  const systemPrompt = `You help South African students draft motivational letters for bursary applications, for the Fundisa website. You will be given the student's name and a set of facts, achievements, and circumstances they've told you about themselves. Write a warm, honest, well-structured first-draft motivational letter (roughly 300-450 words) in the student's voice.

Strict rules:
- Use ONLY the facts, achievements, and circumstances the student actually provided. Never invent grades, awards, financial details, or experiences they didn't mention.
- Do not exaggerate or embellish beyond what was stated.
- Write in first person, as a draft the student will personalize and verify before submitting — not a finished, submission-ready letter.
- Keep the tone genuine and specific rather than generic or flowery.

Respond ONLY with raw JSON (no markdown fences, no preamble) in exactly this shape:
{"letter":"<the drafted letter as plain text with \\n for paragraph breaks>"}`;

  const userMessage = `Student name: ${name}
Field of study: ${fieldOfStudy || 'not specified'}
Target bursary/programme: ${targetBursary || 'not specified'}
Facts, achievements, and circumstances the student provided:
${points}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return sendJSON(res, 502, { error: 'The letter assistant is unavailable right now.' });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock) return sendJSON(res, 502, { error: 'Unexpected response from letter assistant.' });

    const cleaned = textBlock.text.trim().replace(/^```json/, '').replace(/^```/, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    sendJSON(res, 200, { letter: parsed.letter || '' });
  } catch (err) {
    console.error('Letter assistant error:', err);
    sendJSON(res, 500, { error: 'Something went wrong reaching the letter assistant.' });
  }
}

// ---------- router ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname, searchParams } = url;
  const { method } = req;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    });
    return res.end();
  }

  try {
    if (pathname === '/api/health' && method === 'GET') return sendJSON(res, 200, { ok: true });
    if (pathname === '/api/bursaries' && method === 'GET') return await listBursaries(req, res, searchParams);
    if (pathname === '/api/bursaries' && method === 'POST') return await createBursary(req, res);
    if (pathname === '/api/fields' && method === 'GET') return await listFields(req, res);
    if (pathname === '/api/notify' && method === 'POST') return await subscribe(req, res);
    if (pathname === '/api/notify' && method === 'GET') return await listSubscribers(req, res);
    if (pathname === '/api/admin/login' && method === 'POST') return await adminLogin(req, res);
    if (pathname === '/api/assistant' && method === 'POST') return await aiAssistant(req, res);
    if (pathname === '/api/letter-assistant' && method === 'POST') return await letterAssistant(req, res);
    if (pathname === '/api/campaigns' && method === 'GET') return await listCampaigns(req, res);
    if (pathname === '/api/campaigns' && method === 'POST') return await createCampaign(req, res);

    const bursaryMatch = pathname.match(/^\/api\/bursaries\/([\w-]+)$/);
    if (bursaryMatch && method === 'PUT') return await updateBursary(req, res, bursaryMatch[1]);
    if (bursaryMatch && method === 'DELETE') return await deleteBursary(req, res, bursaryMatch[1]);

    const campaignMatch = pathname.match(/^\/api\/campaigns\/([\w-]+)$/);
    if (campaignMatch && method === 'PUT') return await updateCampaign(req, res, campaignMatch[1]);
    if (campaignMatch && method === 'DELETE') return await deleteCampaign(req, res, campaignMatch[1]);

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
