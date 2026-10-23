// The enrollment proof call goes through the safe-mode egress guard like any other outgoing call:
// refused (423 proof-blocked) for a public host unless publicRead is allowed, while loopback works.
// A spy under the guard refuses every non-loopback socket, so nothing leaves the PC.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-site-cred-safe-'));
process.env.APP_DATA_DIR = dataDir;

const reachedSpy = [];
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function testNetSpy(...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  const host = String((first && typeof first === 'object' ? first.host : args[1]) || 'localhost');
  if (/^(127\.\d+\.\d+\.\d+|localhost|::1)$/.test(host)) return realConnect.apply(this, args);
  reachedSpy.push(host);
  process.nextTick(() => this.destroy(Object.assign(new Error(`test spy refused ${host}`), { code: 'ETESTSPY' })));
  return this;
};

const safeMode = await import('../lib/safe-mode.js');
const { fetchEnrollProof } = await import('../lib/site-credentials.js');

test.after(() => {
  safeMode.resetSafeModeForTests();
  net.Socket.prototype.connect = realConnect;
  rmSync(dataDir, { recursive: true, force: true });
});

test('in safe mode the proof call to a public domain is refused by the egress guard and recorded', async () => {
  safeMode.installSafeMode({ env: { ...process.env, HUB_SAFE_MODE: '1', HUB_SAFE_MODE_ALLOW: '' }, dataDir, log: null });
  await assert.rejects(
    fetchEnrollProof({ origin: 'https://shop.example', nonce: 'n'.repeat(43), fetchImpl: (...args) => globalThis.fetch(...args) }),
    (error) => error.code === 'proof-blocked' && error.status === 423,
  );
  assert.deepEqual(reachedSpy, [], 'the guard refused it before any socket');
  assert.ok(safeMode.readRecentIntents(5).some((row) => row.host === 'shop.example'), 'the blocked call is in the intent log');
});

test('in safe mode a loopback CMS still answers (local runs and probes)', async () => {
  safeMode.installSafeMode({ env: { ...process.env, HUB_SAFE_MODE: '1', HUB_SAFE_MODE_ALLOW: '' }, dataDir, log: null });
  const app = express();
  app.get('/api/cms/hub-enroll-proof', (_req, res) => res.json({ proof: 'b'.repeat(64) }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = server.address().port;
    const proof = await fetchEnrollProof({
      origin: 'https://shop.example',
      nonce: 'n'.repeat(43),
      fetchImpl: (...args) => globalThis.fetch(...args),
      resolveUrl: (href) => href.replace('https://shop.example', `http://127.0.0.1:${port}`),
    });
    assert.equal(proof, 'b'.repeat(64));
  } finally {
    server.close();
  }
});
