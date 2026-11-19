// The developer board routes on the real hub (server.js, safe mode, 127.0.0.1 only, egress recorder
// enforcing) read the sales store a small constant number of times per request, however many clients
// and board items there are. The reads are counted inside the hub process and attributed to the request
// that made them (an AsyncLocalStorage context set when the request arrives), so background jobs never
// count. Nothing depends on how long a request takes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOWLIST, AUDIT, REPO, freePort } from './safe-mode/hub-boot.mjs';

const ADMIN = 'board-boot-admin';
const ADMIN_PASSWORD = `board-boot-${Date.now()}-pw`;
const CLIENTS = 200;
const ITEMS = 80;
const MAX_READS_PER_REQUEST = 2;

const COUNTER = `'use strict';
const fs = require('node:fs');
const http = require('node:http');
const { AsyncLocalStorage } = require('node:async_hooks');
const als = new AsyncLocalStorage();
const file = process.env.BOARD_COUNT_FILE;
const append = fs.appendFileSync.bind(fs);
const readFileSync = fs.readFileSync;
fs.readFileSync = function counted(path, ...rest) {
  const request = als.getStore();
  if (request && /sales-clients\\.json$/.test(String(path))) append(file, 'R ' + request + '\\n');
  return readFileSync.call(this, path, ...rest);
};
const writeFileSync = fs.writeFileSync;
fs.writeFileSync = function counted(path, ...rest) {
  const request = als.getStore();
  if (request && /(sales-clients|sites|developer-owner-seed)\\.json$/.test(String(path))) append(file, 'W ' + request + '\\n');
  return writeFileSync.call(this, path, ...rest);
};
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function patched(type, req, ...rest) {
  if (type === 'request' && req && req.method) {
    return als.run(req.method + ' ' + String(req.url).split('?')[0], () => emit.call(this, type, req, ...rest));
  }
  return emit.call(this, type, req, ...rest);
};
`;

function seedData(dataDir) {
  const signed = { meetingHeld: true, offerSent: true, contractSigned: true };
  const clients = [];
  const sites = [];
  for (let i = 0; i < CLIENTS; i += 1) {
    const id = `bc${String(i).padStart(3, '0')}`;
    const row = {
      id,
      product: 'asoldi',
      status: 'active',
      businessName: `Board Synthetic ${i} AS`,
      createdAt: new Date(Date.parse('2026-10-01T10:00:00.000Z') + i * 3_600_000).toISOString(),
      progression: i < ITEMS ? signed : { meetingHeld: true },
      developerOwnerId: 'admin',
    };
    if (i < ITEMS) {
      row.contractSignedAt = '2026-10-01T10:00:00.000Z';
      row.development = { nettsideFerdig: false };
      row.hubSite = { id: `bs${i}`, siteKey: `bkey${i}`, domain: `b${i}.example` };
      if (i % 3 === 0) row.makerRun = { runId: `brun-${String(i).padStart(4, '0')}`, aiSpend: { totalUsd: i / 10, calls: i, receivedAt: '2026-11-01T10:00:00.000Z' } };
      sites.push({ id: `bs${i}`, site_key: `bkey${i}`, name: `Board site ${i}`, domain: `b${i}.example`, deliveryPhase: 'development', createdAt: '2026-09-01T10:00:00.000Z' });
    }
    clients.push(row);
  }
  writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify(clients, null, 2));
  writeFileSync(join(dataDir, 'sites.json'), JSON.stringify(sites, null, 2));
}

async function startHub(dataDir) {
  const port = await freePort();
  const runDir = mkdtempSync(join(tmpdir(), 'asoldi-board-boot-cwd-'));
  const counterFile = join(runDir, 'counter.cjs');
  const countFile = join(runDir, 'count.log');
  writeFileSync(counterFile, COUNTER);
  writeFileSync(countFile, '');
  const shell = { ...process.env };
  for (const key of Object.keys(shell)) {
    if (/^(HUB_SAFE_MODE|HUB_LISTEN_HOST|HOSTINGER|EMAIL_REDIRECT_TO|WEBSITE_MAKER_|SALES_MAKER_STATUS|SALES_PREVIEW_PUSH_URL|HUB_PUBLIC_URL_FOR_MAKER|ADMIN_SECRET)/.test(key)) delete shell[key];
  }
  const child = spawn(process.execPath, [join(REPO, 'server.js')], {
    cwd: runDir,
    env: {
      ...shell,
      HUB_SAFE_MODE: '1',
      PERSIST_PRODUCTION_ENV: '0',
      ADMIN_USERNAME: ADMIN,
      ADMIN_PASSWORD,
      PORT: String(port),
      APP_DATA_DIR: dataDir,
      DATA_DIR: '',
      NODE_OPTIONS: `--require="${AUDIT}" --require="${counterFile.replace(/\\/g, '/')}"`,
      EGRESS_AUDIT_FILE: join(dataDir, `egress-${port}.jsonl`),
      EGRESS_AUDIT_ALLOW: ALLOWLIST,
      EGRESS_AUDIT_ENFORCE: '1',
      BOARD_COUNT_FILE: countFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 160 && !up; i += 1) {
    up = await fetch(`${base}/api/health`).then((res) => res.ok, () => false);
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  let token = '';
  for (let i = 0; i < 20 && up && !token; i += 1) {
    const res = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: ADMIN, password: ADMIN_PASSWORD }) }).catch(() => null);
    token = res ? (await res.json().catch(() => ({}))).token || '' : '';
    if (!token) await new Promise((r) => setTimeout(r, 500));
  }
  const lines = () => readFileSync(countFile, 'utf8').split('\n').filter(Boolean);
  return {
    up,
    token,
    log: () => log,
    /** One request; returns the response and the counted lines of exactly this request kind since the call began. */
    async call(method, path, body) {
      const mark = lines().length;
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      const seen = lines().slice(mark);
      return { status: res.status, text, reads: seen.filter((l) => l.startsWith('R ')).length, writes: seen.filter((l) => l.startsWith('W ')).length, seen };
    },
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 700));
      if (child.exitCode === null) child.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 300));
      rmSync(runDir, { recursive: true, force: true });
    },
  };
}

test('the board routes read the sales store at most twice per request with 200 clients and 80 board items', { timeout: 300_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-board-boot-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  seedData(dataDir);
  const hub = await startHub(dataDir);
  t.after(() => hub.stop());
  assert.ok(hub.up && hub.token, `hub did not start:\n${hub.log().slice(-3000)}`);

  // The first read of a store may rewrite it once (the store's own normalisation); let that settle first.
  for (let i = 0; i < 6; i += 1) {
    const settle = await hub.call('GET', '/api/admin/sales');
    assert.equal(settle.status, 200);
    if (settle.writes === 0 && i > 0) break;
  }

  const list = await hub.call('GET', '/api/admin/development');
  assert.equal(list.status, 200, list.text.slice(0, 300));
  const body = JSON.parse(list.text);
  assert.ok(body.items.length >= ITEMS, `${body.items.length} board items`);
  assert.ok(body.items.every((item) => Object.hasOwn(item, 'delivery')), 'items are decorated');
  assert.ok(list.reads >= 1, `the counter sees the reads of this request (${list.reads})`);
  assert.ok(list.reads <= MAX_READS_PER_REQUEST, `GET /api/admin/development read the sales store ${list.reads} times`);
  assert.equal(list.writes, 0, 'the board GET writes nothing');

  const status = await hub.call('GET', '/api/admin/development/board-status?since=0');
  assert.equal(status.status, 200);
  assert.ok(JSON.parse(status.text).items.length >= ITEMS);
  assert.ok(status.reads >= 1 && status.reads <= MAX_READS_PER_REQUEST, `board-status read the sales store ${status.reads} times`);
  assert.equal(status.writes, 0);

  const itemId = body.items[0].id;
  for (const suffix of ['detail', 'dev-report']) {
    const answer = await hub.call('GET', `/api/admin/development/${encodeURIComponent(itemId)}/${suffix}`);
    assert.equal(answer.status, 200, `${suffix}: ${answer.text.slice(0, 200)}`);
    assert.ok(answer.reads >= 1 && answer.reads <= MAX_READS_PER_REQUEST, `${suffix} read the sales store ${answer.reads} times`);
    assert.equal(answer.writes, 0);
  }

  // The tick (the loop is off): the first run may write the one-time owner seed marker, the second looks again,
  // then the inputs repeat and a tick with nothing to do reads no sales store and writes none.
  for (let i = 0; i < 4; i += 1) {
    const tick = await hub.call('POST', '/api/admin/system/delivery-loop/tick', { now: new Date(Date.parse('2026-11-02T09:00:00.000Z') + i * 60_000).toISOString() });
    assert.equal(tick.status, 200, tick.text.slice(0, 200));
    if (i >= 2) {
      assert.equal(tick.writes, 0, `tick ${i + 1} wrote a store`);
      assert.equal(tick.reads, 0, `tick ${i + 1} read the sales store`);
    }
  }
});
