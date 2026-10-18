import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import express from 'express';
import { cmsOrigin, mintCmsSsoToken, registerCmsSsoRoutes } from '../lib/cms-sso.js';

const site = { id: '42', site_key: 'key-42', domain: 'https://kazal.example/', cms: { adminUrl: 'https://snow.example.com/admin' } };

test('HS-1: token is signed with the site key, lives 60 s and carries a nonce', () => {
  const token = mintCmsSsoToken(site, { by: 'damian', now: 1_000 });
  const { data, sig } = JSON.parse(Buffer.from(token, 'base64url').toString());
  assert.equal(sig, createHmac('sha256', 'key-42').update(data).digest('hex'));
  const body = JSON.parse(data);
  assert.equal(body.sid, '42');
  assert.equal(body.exp, 61_000);
  assert.match(body.n, /^[a-f0-9]{32}$/);
  assert.notEqual(JSON.parse(Buffer.from(mintCmsSsoToken(site), 'base64url').toString()).data, data, 'fresh nonce each time');
});

test('HS-1: CMS origin prefers the heartbeat admin URL, falls back to the domain', () => {
  assert.equal(cmsOrigin(site), 'https://snow.example.com');
  assert.equal(cmsOrigin({ domain: 'kazal.no' }), 'https://kazal.no');
  assert.equal(cmsOrigin({}), '');
});

test('HS-1: only admins get a link, unknown sites 404, sites without an address 409', async () => {
  const app = express();
  const adminAuth = (req, res, next) => (req.get('authorization') === 'Bearer ok' ? ((req.admin = { username: 'damian' }), next()) : res.status(401).end());
  const sites = { 42: site, 7: { id: '7', site_key: 'k7' } };
  registerCmsSsoRoutes(app, { adminAuth, getSiteById: (id) => sites[id] || null });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/hub/sites/42/cms-sso`, { method: 'POST' })).status, 401);
    const ok = await fetch(`${base}/api/hub/sites/42/cms-sso`, { method: 'POST', headers: { authorization: 'Bearer ok' } });
    const body = await ok.json();
    assert.match(body.url, /^https:\/\/snow\.example\.com\/api\/cms\/admin\/sso\?token=[A-Za-z0-9_-]+$/);
    assert.equal(body.expiresInSeconds, 60);
    assert.equal((await fetch(`${base}/api/hub/sites/99/cms-sso`, { method: 'POST', headers: { authorization: 'Bearer ok' } })).status, 404);
    assert.equal((await fetch(`${base}/api/hub/sites/7/cms-sso`, { method: 'POST', headers: { authorization: 'Bearer ok' } })).status, 409);
  } finally {
    server.close();
  }
});
