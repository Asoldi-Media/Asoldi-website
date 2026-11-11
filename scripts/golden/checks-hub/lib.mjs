// Shared helpers of the delivery checks (scripts/golden/checks-hub/delivery-*.mjs).
//
// A check is `export async function check(ctx)` returning
//   { id, status: 'pass' | 'fail' | 'skipped', covers: [release ids], value, findings: [text] }.
// ctx: { dataDir, plan, timeline, labelsDir, transcripts: {clientId: [{meetingId, text}]},
//        expect: { continued: {clientId: runId} }, outDir }.
// Checks read the data folder and the timeline only (no HTTP, no hub data module).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function salesClients(dataDir) {
  const raw = readJson(join(dataDir, 'sales-clients.json'), []);
  return Array.isArray(raw) ? raw : raw?.clients || [];
}

export function clientById(dataDir, id) {
  return salesClients(dataDir).find((client) => client?.id === id) || null;
}

export function hubSites(dataDir) {
  const raw = readJson(join(dataDir, 'sites.json'), []);
  return Array.isArray(raw) ? raw : raw?.sites || [];
}

export function outboxRows(dataDir) {
  const file = join(dataDir, 'outbox', 'index.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/** The outbox entry with its body ({...entry, text, html}), or null (lib/safe-mode-outbox.js layout). */
export function outboxItem(dataDir, id) {
  const entry = outboxRows(dataDir).find((row) => row.id === id);
  if (!entry) return null;
  const body = readJson(join(dataDir, 'outbox', String(entry.day || ''), `${id}.body.json`), {}) || {};
  return { ...entry, text: String(body.text || ''), html: String(body.html || '') };
}

export const SHADOW_CHANNEL = 'delivery-shadow';

export function shadowEntries(dataDir) {
  const raw = readJson(join(dataDir, 'delivery-email-shadow.json'), {});
  return Object.entries(raw?.entries || {}).map(([key, entry]) => ({ key, ...(entry && typeof entry === 'object' ? entry : {}) }));
}

export function deliveryJobs(dataDir) {
  const raw = readJson(join(dataDir, 'delivery-jobs.json'), {});
  return Array.isArray(raw) ? raw : Array.isArray(raw?.jobs) ? raw.jobs : [];
}

export function latestBrief(dataDir, clientId) {
  return readJson(join(dataDir, 'delivery-briefs', clientId, 'latest.json'), null);
}

export function auditRows(dataDir) {
  const dir = join(dataDir, 'delivery-audit');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean)) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // a torn line
      }
    }
  }
  return out;
}

export function lower(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function recipients(row) {
  const raw = Array.isArray(row?.to) ? row.to : String(row?.to ?? '').split(',');
  return raw.map((entry) => lower(typeof entry === 'object' ? entry?.email || entry?.address : entry)).filter(Boolean);
}

export function result(id, covers, findings, value = null, { skipped = '' } = {}) {
  if (skipped) return { id, status: 'skipped', covers, value, findings: [skipped] };
  return { id, status: findings.length ? 'fail' : 'pass', covers, value, findings };
}
