import http from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { getPersistentDataDir } from '../data/storage-path.js';
import { getSalesClients } from '../data/sales.js';
import { researchClientContextLinks } from '../lib/client-context-links.js';

dotenv.config();
const productionEnvPath = join(getPersistentDataDir(), 'production.env');
if (existsSync(productionEnvPath)) dotenv.config({ path: productionEnvPath, override: false });

const HOST = '127.0.0.1';
const PORT = Number(process.env.CONTEXT_LINKS_POC_PORT || 4177);
const key = String(process.env.SERPAPI_API_KEY || process.env.SERP_API_KEY || '').trim();

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

async function searchSerp(query) {
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
  if (!response.ok) throw new Error(`SerpAPI HTTP ${response.status}`);
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

function publicClients() {
  return getSalesClients()
    .filter((client) => client.status !== 'not-sold' && String(client.businessName || '').trim())
    .map((client) => ({
      id: client.id,
      businessName: client.businessName,
      meetingPlace: client.meetingPlace || '',
      meetingMode: client.meetingMode || '',
    }));
}

const PAGE = `<!doctype html>
<html lang="nb">
<head>
  <meta charset="utf-8" />
  <title>Local POC: kundekontekst-lenker</title>
  <style>
    body { font-family: sans-serif; margin: 0; background: #f5f6f8; color: #111827; }
    header { background: #fff; border-bottom: 1px solid #e5e7eb; padding: 16px 24px; }
    main { max-width: 1100px; margin: 0 auto; padding: 20px 24px 48px; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    p.note { margin: 0; color: #6b7280; font-size: 13px; }
    button { background: #ff5b00; color: #fff; border: 0; border-radius: 8px; padding: 8px 14px; cursor: pointer; }
    button:disabled { opacity: .5; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; max-height: 280px; overflow: auto; margin: 12px 0; }
    label { display: flex; gap: 8px; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px; font-size: 14px; }
    article { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; margin-top: 16px; }
    a { color: #1d4ed8; }
    .err { color: #b91c1c; }
    .muted { color: #6b7280; font-size: 12px; }
  </style>
</head>
<body>
  <header>
    <h1>Localhost only — Trustpilot / nyheter</h1>
    <p class="note">This is not the sales page. Nothing is saved to kundekort. Bind: 127.0.0.1</p>
  </header>
  <main>
    <p id="status" class="muted"></p>
    <button id="run" type="button">Kjør søk på valgte</button>
    <div id="clients" class="grid"></div>
    <div id="out"></div>
  </main>
  <script>
    const clientsEl = document.getElementById('clients');
    const statusEl = document.getElementById('status');
    const outEl = document.getElementById('out');
    let selected = [];
    async function load() {
      const data = await (await fetch('/api/clients')).json();
      statusEl.textContent = data.configured
        ? data.clients.length + ' lokale kunder lastet. SerpAPI: på'
        : data.clients.length + ' lokale kunder lastet. SerpAPI: mangler nøkkel i .env / production.env';
      selected = data.clients.slice(0, 3).map((c) => c.id);
      clientsEl.innerHTML = data.clients.map((c) => (
        '<label><input type="checkbox" value="' + c.id + '"' + (selected.includes(c.id) ? ' checked' : '') + '/>'
        + '<span><strong>' + c.businessName + '</strong><br/><span class="muted">'
        + (c.meetingMode === 'in-person' ? 'IRL' : 'Online')
        + (c.meetingPlace ? ' · ' + c.meetingPlace : '')
        + '</span></span></label>'
      )).join('');
      clientsEl.querySelectorAll('input').forEach((input) => {
        input.addEventListener('change', () => {
          selected = [...clientsEl.querySelectorAll('input:checked')].map((el) => el.value).slice(0, 8);
        });
      });
    }
    document.getElementById('run').addEventListener('click', async () => {
      outEl.innerHTML = 'Søker…';
      const response = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientIds: selected }),
      });
      const data = await response.json();
      if (!response.ok) {
        outEl.innerHTML = '<p class="err">' + (data.message || 'Feil') + '</p>';
        return;
      }
      outEl.innerHTML = (data.runs || []).map((run) => {
        const kept = (run.kept || []).map((link) => (
          '<p><span class="muted">' + link.kind + '</span><br/><a href="' + link.url + '" target="_blank" rel="noreferrer">'
          + (link.title || link.url) + '</a><br/><span class="muted">' + (link.snippet || '') + '</span></p>'
        )).join('') || '<p class="muted">Ingen beholdt.</p>';
        const rejected = (run.rejected || []).slice(0, 5).map((link) => (
          '<p class="muted">' + link.reason + ' · ' + (link.title || link.url) + '</p>'
        )).join('');
        return '<article><h2>' + run.businessName + '</h2><p class="muted">' + (run.queries || []).join(' · ')
          + '</p><h3>Beholdt</h3>' + kept + '<h3>Forkastet</h3>' + rejected + '</article>';
      }).join('');
    });
    load().catch((err) => { statusEl.textContent = String(err); });
  </script>
</body>
</html>`;

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/clients') {
      sendJson(res, 200, { configured: Boolean(key), writesToClients: false, clients: publicClients() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/run') {
      if (!key) {
        sendJson(res, 503, { message: 'SERPAPI_API_KEY missing in local .env or production.env' });
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const ids = Array.isArray(body.clientIds) ? body.clientIds.map(String).filter(Boolean).slice(0, 8) : [];
      const byId = new Map(getSalesClients().map((client) => [client.id, client]));
      const selected = (ids.length ? ids : publicClients().slice(0, 2).map((client) => client.id))
        .map((id) => byId.get(id))
        .filter(Boolean);
      const runs = [];
      for (const client of selected) {
        runs.push(await researchClientContextLinks(client, { search: searchSerp }));
      }
      sendJson(res, 200, { ok: true, writesToClients: false, runs });
      return;
    }
    sendJson(res, 404, { message: 'Not found' });
  } catch (error) {
    sendJson(res, 500, { message: error instanceof Error ? error.message : 'Failed' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Local context-links POC: http://${HOST}:${PORT}`);
  console.log(`SerpAPI: ${key ? 'configured' : 'missing'}`);
  console.log('Not bound to the sales page. Ctrl+C to stop.');
});
