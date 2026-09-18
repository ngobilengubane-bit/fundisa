const API_BASE = (process.env.FUNDISA_API_URL || '').replace(/\/$/, '');
const secret = process.env.MONITOR_SECRET || '';
if (!API_BASE || !secret) {
  console.error('Set FUNDISA_API_URL and MONITOR_SECRET before running the Fundisa monitor.');
  process.exit(1);
}
const headers = { 'x-monitor-secret': secret };
let exitCode = 0;

try {
  const sync = await fetch(`${API_BASE}/api/maintenance/sync-bursaries`, { method: 'POST', headers });
  const syncText = await sync.text();
  console.log(JSON.stringify({ step: 'public_source_sync', ok: sync.ok, response: syncText }));
  if (!sync.ok && sync.status !== 503) exitCode = 1;
} catch (err) {
  console.error(JSON.stringify({ step: 'public_source_sync', ok: false, error: err.message }));
}

try {
  // Spread official-web verification across runs so a growing catalogue does not
  // produce hundreds of AI web-search calls in one cron invocation.
  const response = await fetch(`${API_BASE}/api/maintenance/check-bursaries?limit=30`, { method: 'POST', headers });
  const text = await response.text();
  console.log(JSON.stringify({ step: 'freshness_check', ok: response.ok, response: text }));
  if (!response.ok) exitCode = 1;
} catch (err) {
  console.error(JSON.stringify({ step: 'freshness_check', ok: false, error: err.message }));
  exitCode = 1;
}


try {
  const response = await fetch(`${API_BASE}/api/maintenance/notification-sweep`, { method: 'POST', headers });
  const text = await response.text();
  console.log(JSON.stringify({ step: 'notification_sweep', ok: response.ok, response: text }));
  if (!response.ok) exitCode = 1;
} catch (err) {
  console.error(JSON.stringify({ step: 'notification_sweep', ok: false, error: err.message }));
  exitCode = 1;
}

process.exit(exitCode);
