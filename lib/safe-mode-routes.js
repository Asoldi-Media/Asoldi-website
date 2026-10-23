/**
 * Safe-mode admin endpoints.
 *
 *   GET /api/admin/system/safe-mode          state, jobs, counters, egress rules, recent intents (admin)
 *   GET /api/admin/system/outbox?limit=50    outbox list (admin, safe mode only)
 *   GET /api/admin/system/outbox/:id         one item: metadata + plain text (admin, safe mode only)
 *   GET /api/admin/system/outbox/:id/eml     the raw .eml as a download (admin, safe mode only)
 *   GET /api/safe-mode/outbox-preview/:id    sandboxed HTML preview, signed short-lived URL, no token
 */
import { readFileSync } from 'node:fs';
import { describeSafeMode, isSafeModeActive, readRecentIntents, safeModeDataDir } from './safe-mode.js';
import {
  OUTBOX_PREVIEW_CSP,
  listOutbox,
  outboxPreviewDocument,
  readOutboxItem,
  signedPreviewPath,
  verifyPreviewSignature,
} from './safe-mode-outbox.js';

function notInSafeMode(res) {
  return res.status(404).json({ message: 'The outbox exists only while hub safe mode is on.' });
}

export function registerSafeModeRoutes(app, { adminAuth }) {
  if (typeof adminAuth !== 'function') throw new Error('registerSafeModeRoutes needs adminAuth');

  app.get('/api/admin/system/safe-mode', adminAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const snapshot = describeSafeMode();
    let outbox = null;
    if (isSafeModeActive()) {
      try {
        outbox = { total: listOutbox(safeModeDataDir(), { limit: 1 }).total };
      } catch {
        outbox = { total: 0 };
      }
    }
    res.json({ ...snapshot, outbox, intents: isSafeModeActive() ? readRecentIntents(Number(req.query.intents) || 50) : [] });
  });

  app.get('/api/admin/system/outbox', adminAuth, (req, res) => {
    if (!isSafeModeActive()) return notInSafeMode(res);
    res.set('Cache-Control', 'no-store');
    const { total, items } = listOutbox(safeModeDataDir(), { limit: Number(req.query.limit) || 50 });
    res.json({ total, items: items.map((item) => ({ ...item, previewUrl: signedPreviewPath(item.id) })) });
  });

  app.get('/api/admin/system/outbox/:id', adminAuth, (req, res) => {
    if (!isSafeModeActive()) return notInSafeMode(res);
    const item = readOutboxItem(safeModeDataDir(), req.params.id);
    if (!item) return res.status(404).json({ message: 'Outbox item not found.' });
    res.set('Cache-Control', 'no-store');
    const { html, emlPath, ...meta } = item;
    res.json({ ...meta, hasHtml: Boolean(html), previewUrl: signedPreviewPath(item.id) });
  });

  app.get('/api/admin/system/outbox/:id/eml', adminAuth, (req, res) => {
    if (!isSafeModeActive()) return notInSafeMode(res);
    const item = readOutboxItem(safeModeDataDir(), req.params.id);
    if (!item?.emlPath) return res.status(404).json({ message: 'Outbox item not found.' });
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${item.id}.eml"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.send(readFileSync(item.emlPath));
  });

  app.get('/api/safe-mode/outbox-preview/:id', (req, res) => {
    if (!isSafeModeActive()) return notInSafeMode(res);
    const { id } = req.params;
    if (!verifyPreviewSignature(id, req.query.exp, req.query.sig)) {
      return res.status(403).type('text/plain').send('Preview link expired. Reload the outbox.');
    }
    const item = readOutboxItem(safeModeDataDir(), id);
    if (!item) return res.status(404).type('text/plain').send('Not found');
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': OUTBOX_PREVIEW_CSP,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    });
    res.send(outboxPreviewDocument(item));
  });
}
