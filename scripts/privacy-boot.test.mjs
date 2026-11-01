// The real hub (server.js) in safe mode on 127.0.0.1, from an empty working folder, with a synthetic
// data dir. With every privacy switch off: the new routes answer 404 {code:'disabled'} (erase 403),
// the purpose route still refuses 'demo' with the old answer, and nothing new is written on the data
// disk. Then the ranker switch, set through the settings route, lets an admin pick 'demo'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootHub } from './safe-mode/hub-boot.mjs';

const ADMIN = 'privacy-boot-admin';
const PASSWORD = `privacy-boot-${Date.now()}-pw`;

function seed(dataDir) {
  const at = '2026-10-01T10:00:00.000Z';
  writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify([
    {
      id: 'boot-client',
      product: 'asoldi',
      businessName: 'Boot Test AS',
      contactEmail: 'boot@example.com',
      status: 'active',
      createdAt: at,
      updatedAt: at,
      progression: { meetingHeld: true },
      meetings: [{ meetingId: 'boot-rec', title: 'Møte', startedAt: '2026-10-20T10:00:00.000Z', linkedBy: 'admin:boot', linkedAt: at }],
    },
  ], null, 2));
  writeFileSync(join(dataDir, 'fireflies-meetings.json'), JSON.stringify({
    'boot-rec': { meetingId: 'boot-rec', title: 'Møte', startedAt: '2026-10-20T10:00:00.000Z', transcript: 'A: Hei.', at, firstSeenAt: at, final: true },
  }, null, 2));
}

test('privacy switches off on the real hub: new routes are disabled, demo is refused, nothing new is written', async () => {
  const hub = await bootHub({ HUB_SAFE_MODE: '1', PERSIST_PRODUCTION_ENV: '0', ADMIN_USERNAME: ADMIN, ADMIN_PASSWORD: PASSWORD }, { seed });
  try {
    assert.ok(hub.health, `hub did not boot:\n${hub.log().slice(-2000)}`);
    const token = await hub.adminToken(ADMIN, PASSWORD);
    assert.ok(token, 'admin token');
    const call = (method, path, body, auth = token) => fetch(`${hub.base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const media = await call('GET', `/api/maker/media/ma_${'0'.repeat(32)}?c=boot-client&exp=99999999999999&sig=${'a'.repeat(64)}`, undefined, '');
    assert.equal(media.status, 404);
    assert.equal((await media.json()).code, 'disabled');
    for (const path of ['/api/admin/fireflies/candidates', '/api/admin/sales/boot-client/media-manifest']) {
      const res = await call('GET', path);
      assert.equal(res.status, 404, path);
      assert.equal((await res.json()).code, 'disabled', path);
    }
    const erase = await call('POST', '/api/admin/sales/boot-client/erase', { dryRun: false });
    assert.equal(erase.status, 403);
    assert.equal((await erase.json()).code, 'purge-disabled');
    const demo = await call('POST', '/api/admin/sales/boot-client/meetings/boot-rec/purpose', { purpose: 'demo' });
    assert.equal(demo.status, 400);
    assert.equal((await demo.json()).message, 'Velg salgsmøte, workshop, iterasjon eller automatisk.');
    const exported = await call('GET', '/api/admin/sales/boot-client/personal-data-export');
    assert.equal(exported.status, 200, 'export is read-only and superadmin-only');
    assert.equal((await call('GET', '/api/admin/sales/boot-client/personal-data-export', undefined, '')).status, 401);

    for (const rel of ['transcript-archive', 'privacy', 'media-manifest', 'fireflies-link-audit', 'media-rights.json', join('secrets', 'media-signing')]) {
      assert.equal(existsSync(join(hub.dataDir, rel)), false, `${rel} not written while the switches are off`);
    }

    const saved = await call('PUT', '/api/admin/automation-settings', { fireflies: { candidateRanker: { enabled: true } } });
    assert.equal(saved.status, 200);
    const picked = await call('POST', '/api/admin/sales/boot-client/meetings/boot-rec/purpose', { purpose: 'demo' });
    assert.equal(picked.status, 200, await picked.clone().text());
    const row = (await picked.json()).client.meetings.find((entry) => entry.meetingId === 'boot-rec');
    assert.equal(row.purpose, 'demo');
    const candidates = await call('GET', '/api/admin/fireflies/candidates');
    assert.equal(candidates.status, 200);
  } finally {
    await hub.stop();
  }
});
