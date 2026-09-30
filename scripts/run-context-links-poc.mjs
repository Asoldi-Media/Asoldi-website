import dotenv from 'dotenv';
import { getSalesClients } from '../data/sales.js';
import { researchClientContextLinks } from '../lib/client-context-links.js';

dotenv.config();

const key = String(process.env.SERPAPI_API_KEY || process.env.SERP_API_KEY || '').trim();
const limit = Math.min(3, Math.max(1, Number(process.env.CONTEXT_LINKS_POC_LIMIT) || 2));

function coerceHttpUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(candidate);
    if (!/^https?:$/i.test(parsed.protocol)) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

async function search(query) {
  if (!key || !query) return [];
  const params = new URLSearchParams({
    engine: 'google',
    q: query,
    api_key: key,
    num: '10',
    hl: 'no',
    gl: 'no',
  });
  const response = await fetch(`https://serpapi.com/search.json?${params}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`SerpAPI HTTP ${response.status}`);
  }
  const payload = await response.json();
  const rows = Array.isArray(payload?.organic_results) ? payload.organic_results : [];
  return rows
    .map((entry) => ({
      url: coerceHttpUrl(entry?.link || ''),
      title: String(entry?.title || '').trim(),
      snippet: String(entry?.snippet || '').trim(),
    }))
    .filter((entry) => entry.url);
}

const clients = getSalesClients()
  .filter((client) => client.status !== 'not-sold' && String(client.businessName || '').trim())
  .slice(0, limit);

console.log(JSON.stringify({
  configured: Boolean(key),
  clientCountAvailable: getSalesClients().length,
  testing: clients.map((client) => client.businessName),
}, null, 2));

if (!key) {
  console.log('Skip live SerpAPI: no key in env.');
  process.exit(0);
}

for (const client of clients) {
  const result = await researchClientContextLinks(client, { search });
  console.log(JSON.stringify({
    businessName: result.businessName,
    queries: result.queries,
    kept: result.kept.map((entry) => ({ kind: entry.kind, title: entry.title, url: entry.url })),
    rejectedSample: result.rejected.slice(0, 3).map((entry) => ({ reason: entry.reason, title: entry.title })),
  }, null, 2));
}
