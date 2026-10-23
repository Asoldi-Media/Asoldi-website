// Outbox storage, 30-day expiry, and the admin/preview routes (sandboxed, CSP, signed links).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-safe-outbox-'));
process.env.APP_DATA_DIR = dataDir;

const safeMode = await import('../lib/safe-mode.js');
const outbox = await import('../lib/safe-mode-outbox.js');
const { registerSafeModeRoutes } = await import('../lib/safe-mode-routes.js');

const HOSTILE_HTML = '<html><head><title>x</title></head><body><p>Hei</p><script>localStorage.adminToken</script><img src="https://tracker.example.invalid/p.gif"><form action="https://evil.example.invalid"></form></body></html>';

async function startApp() {
  const app = express();
  const adminAuth = (req, res, next) => (req.headers.authorization === 'Bearer admin' ? next() : res.status(401).json({ message: 'Unauthorized' }));
  registerSafeModeRoutes(app, { adminAuth });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('writeOutboxEmail stores MIME, body and an index line; list/read return them', async () => {
  const entry = await outbox.writeOutboxEmail(dataDir, { to: 'a@example.invalid, b@example.invalid', subject: 'Hei', html: HOSTILE_HTML, text: 'Hei', from: 'Asoldi <contact@asoldi.com>' }, { transport: 'resend' });
  assert.ok(outbox.isOutboxId(entry.id));
  assert.deepEqual(entry.to, ['a@example.invalid', 'b@example.invalid']);
  const listed = outbox.listOutbox(dataDir);
  assert.equal(listed.total, 1);
  const item = outbox.readOutboxItem(dataDir, entry.id);
  assert.equal(item.subject, 'Hei');
  assert.ok(existsSync(item.emlPath));
  assert.equal(outbox.readOutboxItem(dataDir, '../../etc/passwd'), null, 'ids are validated (no path traversal)');
});

test('href/url attachments are never fetched while building the MIME', async () => {
  const entry = await outbox.writeOutboxEmail(dataDir, {
    to: 'x@example.invalid',
    subject: 'att',
    text: 't',
    attachments: [{ filename: 'remote.pdf', href: 'https://example.invalid/remote.pdf' }, { filename: 'local.txt', content: 'hello' }],
  });
  const eml = readFileSync(outbox.readOutboxItem(dataDir, entry.id).emlPath, 'utf8');
  assert.match(eml, /local\.txt/);
  assert.doesNotMatch(eml, /remote\.pdf/);
});

test('items older than 30 days are deleted (files and index lines)', async () => {
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  const stale = await outbox.writeOutboxEmail(dataDir, { to: 'old@example.invalid', subject: 'old', text: 'old' }, { now: old });
  assert.ok(existsSync(join(dataDir, 'outbox', stale.day)));
  const result = outbox.purgeExpiredOutbox(dataDir);
  assert.equal(result.removedDays, 1);
  assert.ok(result.removedEntries >= 1);
  assert.equal(existsSync(join(dataDir, 'outbox', stale.day)), false);
  assert.equal(outbox.readOutboxItem(dataDir, stale.id), null);
  assert.ok(outbox.listOutbox(dataDir).items.every((item) => item.id !== stale.id));
});

test('preview document: escapes text-only mail; the CSP forbids scripts and remote loads', () => {
  const doc = outbox.outboxPreviewDocument({ text: '<script>alert(1)</script>', html: '' });
  assert.doesNotMatch(doc, /<script>alert/);
  assert.match(doc, /&lt;script&gt;/);
  assert.match(outbox.OUTBOX_PREVIEW_CSP, /^sandbox;/);
  assert.match(outbox.OUTBOX_PREVIEW_CSP, /default-src 'none'/);
  assert.doesNotMatch(outbox.OUTBOX_PREVIEW_CSP, /script-src|allow-scripts|allow-same-origin|https:/);
});

test('signed preview links expire and cannot be reused for another id', () => {
  const id = '20261023T101010Z-123e4567-e89b-42d3-a456-426614174000';
  const path = outbox.signedPreviewPath(id, { now: 1_000_000 });
  const params = new URL(`http://x${path}`).searchParams;
  assert.equal(outbox.verifyPreviewSignature(id, params.get('exp'), params.get('sig'), { now: 1_000_000 }), true);
  assert.equal(outbox.verifyPreviewSignature(id, params.get('exp'), params.get('sig'), { now: 1_000_000 + 11 * 60_000 }), false, 'expired');
  const other = '20261023T101010Z-123e4567-e89b-42d3-a456-426614174001';
  assert.equal(outbox.verifyPreviewSignature(other, params.get('exp'), params.get('sig'), { now: 1_000_000 }), false);
  assert.equal(outbox.verifyPreviewSignature(id, params.get('exp'), 'forged', { now: 1_000_000 }), false);
});

test('routes: admin-only list/item, sandboxed preview with strict headers, safe mode only', async () => {
  safeMode.installSafeMode({ env: { HUB_SAFE_MODE: '1' }, dataDir, log: null, egress: false });
  const entry = await outbox.writeOutboxEmail(dataDir, { to: 'r@example.invalid', subject: 'Route', html: HOSTILE_HTML, text: 'plain' });
  const { server, base } = await startApp();
  try {
    assert.equal((await fetch(`${base}/api/admin/system/outbox`)).status, 401);
    assert.equal((await fetch(`${base}/api/admin/system/safe-mode`)).status, 401);
    const list = await (await fetch(`${base}/api/admin/system/outbox`, { headers: { Authorization: 'Bearer admin' } })).json();
    const row = list.items.find((item) => item.id === entry.id);
    assert.ok(row?.previewUrl.startsWith('/api/safe-mode/outbox-preview/'));
    assert.doesNotMatch(row.previewUrl, /admin/, 'no staff token in the preview link');
    const item = await (await fetch(`${base}/api/admin/system/outbox/${entry.id}`, { headers: { Authorization: 'Bearer admin' } })).json();
    assert.equal(item.html, undefined, 'raw HTML is never returned to the admin page as JSON');
    assert.equal(item.text, 'plain');
    const preview = await fetch(`${base}${row.previewUrl}`);
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get('content-security-policy'), /^sandbox; default-src 'none'/);
    assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(preview.headers.get('referrer-policy'), 'no-referrer');
    assert.match(await preview.text(), /Hei/);
    assert.equal((await fetch(`${base}/api/safe-mode/outbox-preview/${entry.id}?exp=1&sig=x`)).status, 403);
    const eml = await fetch(`${base}/api/admin/system/outbox/${entry.id}/eml`, { headers: { Authorization: 'Bearer admin' } });
    assert.match(eml.headers.get('content-disposition'), /attachment/);
    const state = await (await fetch(`${base}/api/admin/system/safe-mode`, { headers: { Authorization: 'Bearer admin' } })).json();
    assert.equal(state.safeMode, true);
    assert.ok(state.jobs.salesReminders);
    assert.ok(Array.isArray(state.egress));
    assert.ok(state.outbox.total >= 1);
    safeMode.installSafeMode({ env: { HOSTINGER: '1' }, dataDir, log: null, egress: false });
    assert.equal((await fetch(`${base}/api/admin/system/outbox`, { headers: { Authorization: 'Bearer admin' } })).status, 404, 'no outbox in production');
    assert.equal((await fetch(`${base}${row.previewUrl}`)).status, 404);
    const prodState = await (await fetch(`${base}/api/admin/system/safe-mode`, { headers: { Authorization: 'Bearer admin' } })).json();
    assert.equal(prodState.safeMode, false);
  } finally {
    server.close();
  }
});

test.after(() => {
  safeMode.resetSafeModeForTests();
  rmSync(dataDir, { recursive: true, force: true });
});
