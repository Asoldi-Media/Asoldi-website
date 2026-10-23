// Delivery audit log (WS8.9): one append-only JSON line per stage change, plan write, email stamp
// and backfill run, in <dataDir>/delivery-audit/<YYYY-MM>.jsonl (one file per month).
// Ids, stage names and tier ids only: no names, addresses or message text. Appending never throws;
// a failed append is reported on the console and the write it describes still counts.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPersistentDataDir } from '../data/storage-path.js';

export const DELIVERY_AUDIT_DIR = 'delivery-audit';
const MAX_FIELD = 200;

function clean(entry = {}) {
  const out = {};
  for (const [key, value] of Object.entries(entry || {})) {
    if (value === undefined || value === '') continue;
    if (typeof value === 'string') out[key] = value.slice(0, MAX_FIELD);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
    else if (Array.isArray(value)) out[key] = value.slice(0, 20).map((item) => String(item).slice(0, 80));
  }
  return out;
}

export function deliveryAuditFile(dataDir, at = new Date()) {
  const month = (at instanceof Date ? at : new Date(at)).toISOString().slice(0, 7);
  return join(dataDir || getPersistentDataDir(), DELIVERY_AUDIT_DIR, `${month}.jsonl`);
}

export function appendDeliveryAudit(entry = {}, { dataDir } = {}) {
  try {
    const parsed = Date.parse(String(entry?.at || ''));
    const at = Number.isFinite(parsed) ? new Date(parsed) : new Date();
    const file = deliveryAuditFile(dataDir, at);
    const dir = join(dataDir || getPersistentDataDir(), DELIVERY_AUDIT_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(file, `${JSON.stringify({ ...clean(entry), at: at.toISOString() })}\n`);
    return true;
  } catch (error) {
    console.warn('[delivery] audit append failed:', error?.message || error);
    return false;
  }
}

export function readDeliveryAudit({ dataDir, month = new Date().toISOString().slice(0, 7) } = {}) {
  const file = join(dataDir || getPersistentDataDir(), DELIVERY_AUDIT_DIR, `${month}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}
