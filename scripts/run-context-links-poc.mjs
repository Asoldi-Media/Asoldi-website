import http from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { researchClientContextLinks, CONTEXT_SEARCH_SERP_PARAMS } from '../lib/client-context-links.js';
import { deepseekChatJson, isDeepseekConfigured } from '../lib/deepseek.js';
import {
  listSerpApiKeys,
  runWithSerpApiFailover,
  serpApiErrorMeansNoCredits,
} from '../lib/serpapi-keys.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const makerRoot = resolve(root, '..', 'website-maker');
for (const file of [
  join(root, '.env'),
  join(root, '.env.local'),
  join(makerRoot, '.env'),
  join(makerRoot, '.env.local'),
]) {
  if (existsSync(file)) dotenv.config({ path: file, override: false });
}

const HOST = '127.0.0.1';
const PORT = Number(process.env.CONTEXT_LINKS_POC_PORT || 47821);

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

async function searchSerp(query, { engine = 'google' } = {}) {
  if (!listSerpApiKeys().length || !query) {
    throw new Error('SERPAPI_API_KEY missing');
  }
  const failover = await runWithSerpApiFailover(async (apiKey) => {
    const params = new URLSearchParams({
      engine,
      q: query,
      api_key: apiKey,
      num: '10',
      ...CONTEXT_SEARCH_SERP_PARAMS,
    });
    const response = await fetch(`https://serpapi.com/search.json?${params}`, {
      headers: { Accept: 'application/json' },
    });
    const payload = await response.json().catch(() => ({}));
    if (serpApiErrorMeansNoCredits(response.status, payload)) return { status: 'no-credits' };
    if (!response.ok) {
      if (response.status === 429) return { status: 'throttled', retryAfterMs: 30_000 };
      return { status: 'error', error: new Error(payload.error || `SerpAPI HTTP ${response.status}`) };
    }
    const rows = engine === 'google_news'
      ? (Array.isArray(payload?.news_results) ? payload.news_results : [])
      : (Array.isArray(payload?.organic_results) ? payload.organic_results : []);
    return {
      status: 'ok',
      value: rows
        .map((entry, index) => ({
          url: coerceHttpUrl(entry?.link || ''),
          title: String(entry?.title || '').trim(),
          snippet: String(entry?.snippet || entry?.highlight || '').trim(),
          position: index,
        }))
        .filter((entry) => entry.url),
    };
  });
  if (failover.ok) return Array.isArray(failover.value) ? failover.value : [];
  throw failover.error || new Error('SerpAPI search failed');
}

async function judgeNovelLinks(candidates, client) {
  if (!isDeepseekConfigured() || !candidates.length) return candidates.slice(0, 3);
  const parsed = await deepseekChatJson({
    temperature: 0.1,
    maxTokens: 400,
    system: [
      'You pick extra research links for a Norwegian sales team.',
      'We already have Proff.no, the company website, Instagram, Facebook, Google Maps, and business directories (1881, Gule Sider, Cylex, Infobel, Yelono, Restaurant Guru).',
      'Keep a URL only if the page itself is about THIS business: a news article, interview, feature, or independent review (Trustpilot-style).',
      'Reject passing mentions, related-story teasers, the company website, social profiles, Wikipedia/SNL, kommune/place pages, other businesses, and directory clones.',
      'Return JSON { "urls": string[] } with 0 to 3 URLs copied exactly from the candidate list. Empty is correct when nothing is useful.',
    ].join(' '),
    user: JSON.stringify({
      businessName: client.businessName,
      candidates: candidates.map((entry) => ({
        url: entry.url,
        title: entry.title,
        snippet: entry.snippet,
        kind: entry.kind,
      })),
    }),
  });
  const urls = Array.isArray(parsed?.urls) ? parsed.urls : [];
  return urls.map((url) => ({ url }));
}

const PAGE = `<!doctype html>
<html lang="nb">
<head>
  <meta charset="utf-8" />
  <title>Local extra-link test</title>
  <style>
    body { font-family: sans-serif; margin: 40px auto; max-width: 720px; color: #111; }
    input, button { font: inherit; padding: 8px 10px; }
    input { width: 100%; box-sizing: border-box; margin: 4px 0 12px; }
    button { background: #111; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
    button:disabled { opacity: .5; }
    a { color: #1d4ed8; }
    .muted { color: #6b7280; font-size: 13px; }
    .err { color: #b91c1c; }
    article { margin-top: 20px; padding-top: 16px; border-top: 1px solid #e5e7eb; }
    .drop { font-size: 13px; color: #6b7280; }
  </style>
</head>
<body>
  <h1>Extra links (0–3)</h1>
  <p class="muted">Norwegian Google (google.no). Drops AS. Short names get industry. Articles and reviews only, 0–3 links. Not the sales page.</p>
  <label>Business name</label>
  <input id="name" type="text" placeholder="e.g. Rosto" />
  <label>Industry (used when the name is under 7 characters)</label>
  <input id="industry" type="text" placeholder="e.g. restaurant" />
  <button id="run" type="button">Search</button>
  <p id="status" class="muted"></p>
  <div id="out"></div>
  <script>
    const statusEl = document.getElementById('status');
    const outEl = document.getElementById('out');
    const runEl = document.getElementById('run');
    document.getElementById('run').addEventListener('click', async () => {
      const businessName = document.getElementById('name').value.trim();
      const industry = document.getElementById('industry').value.trim();
      if (!businessName) {
        statusEl.textContent = 'Type a business name.';
        return;
      }
      runEl.disabled = true;
      outEl.innerHTML = '';
      statusEl.textContent = 'Searching Google…';
      try {
        const response = await fetch('/api/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ businessName, industry }),
        });
        const data = await response.json();
        if (!response.ok) {
          statusEl.innerHTML = '<span class="err">' + (data.message || 'Failed') + '</span>';
          return;
        }
        statusEl.textContent = 'Query: ' + (data.query || '') + ' · kept ' + (data.kept || []).length + ' of 0–3';
        const keptHtml = (data.kept || []).map((link) => (
          '<article><a href="' + link.url + '" target="_blank" rel="noreferrer">'
          + (link.title || link.url) + '</a><div class="muted">' + (link.kind || '') + ' · ' + link.url
          + '</div><p>' + (link.snippet || '') + '</p></article>'
        )).join('') || '<p class="muted">No extra articles or reviews.</p>';
        const dropped = (data.rejected || []).slice(0, 8).map((link) => (
          '<div class="drop">' + (link.reason || 'dropped') + ' — ' + (link.title || link.url) + '</div>'
        )).join('');
        outEl.innerHTML = keptHtml + (dropped ? '<h3 class="muted">Dropped from page 1</h3>' + dropped : '');
      } catch (err) {
        statusEl.innerHTML = '<span class="err">' + String(err) + '</span>';
      } finally {
        runEl.disabled = false;
      }
    });
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

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function runResearch(businessName, industry = '') {
  return researchClientContextLinks(
    { businessName, industry },
    { search: searchSerp, judge: judgeNovelLinks }
  );
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/run') {
      if (!listSerpApiKeys().length) {
        sendJson(res, 503, { message: 'SERPAPI_API_KEY missing' });
        return;
      }
      const body = await readBody(req);
      const businessName = String(body.businessName || '').trim();
      const industry = String(body.industry || '').trim();
      const result = await runResearch(businessName, industry);
      sendJson(res, 200, {
        query: (result.queries || [])[0] || '',
        kept: result.kept || [],
        rejected: result.rejected || [],
      });
      return;
    }
    sendJson(res, 404, { message: 'Not found' });
  } catch (error) {
    sendJson(res, 500, { message: error instanceof Error ? error.message : 'Failed' });
  }
});

if (process.argv.includes('--once')) {
  const args = process.argv.slice(2).filter((arg) => arg !== '--once');
  const name = args[0] || 'Byneset Bydelskafe';
  const industry = args[1] || '';
  const result = await runResearch(name, industry);
  console.log(JSON.stringify({
    query: (result.queries || [])[0] || '',
    kept: (result.kept || []).map((entry) => ({ kind: entry.kind, title: entry.title, url: entry.url })),
    rejected: (result.rejected || []).map((entry) => ({ reason: entry.reason, title: entry.title, url: entry.url })),
  }, null, 2));
  process.exit(0);
}

server.listen(PORT, HOST, () => {
  console.log(`http://${HOST}:${PORT}`);
  console.log(`SerpAPI keys: ${listSerpApiKeys().length}`);
  console.log(`DeepSeek: ${isDeepseekConfigured() ? 'on' : 'off'}`);
});
