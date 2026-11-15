import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCursorPrompt, CURSOR_PROMPT_MAX_CHARS, CURSOR_PROMPT_MODEL } from '../lib/cursor-prompt.js';
import { bootHub } from './safe-mode/hub-boot.mjs';

const PLANTED = {
  quote: 'Behold produktene som de er i sitatet.',
  email: 'post@example.com',
  token: 'sk-planted-token-fjordlys',
};

function forbidden(text) {
  return [PLANTED.quote, PLANTED.email, PLANTED.token].filter((bit) => text.includes(bit));
}

function promptInput(extra = {}) {
  return {
    client: {
      businessName: 'Fjordlys Keramikk AS',
      contactEmail: PLANTED.email,
      contactPhone: '+47 000 00 000',
      label: PLANTED.token,
    },
    runId: 'run-fjordlys-1',
    tier: 'tier-1-standard',
    services: ['site', 'blog'],
    directives: [
      { id: 'dir-accepted-1', status: 'accepted', priority: 'must', appliedInJobs: [], quote: PLANTED.quote, ask: PLANTED.quote },
      { id: 'dir-proposed-1', status: 'open', priority: 'must', quote: PLANTED.quote },
    ],
    changeRequests: [{ id: 'cr-open-1', status: 'accepted', title: PLANTED.quote, description: PLANTED.email }],
    threadAsks: [{ id: 'ask-1', text: PLANTED.token }],
    ...extra,
  };
}

test('the cursor prompt names a Claude model and carries ids only', () => {
  const input = promptInput();
  const prompt = buildCursorPrompt(input);
  assert.ok(prompt.length > 0 && prompt.length <= CURSOR_PROMPT_MAX_CHARS, `chars ${prompt.length}`);
  assert.equal(prompt.split('\n')[0], `Bruk modellen ${CURSOR_PROMPT_MODEL}.`);
  assert.match(prompt, /run-fjordlys-1/);
  assert.match(prompt, /dir-accepted-1/);
  assert.match(prompt, /dir-proposed-1/);
  assert.match(prompt, /x-asoldi-local: 1/);
  assert.match(prompt, /source:"agent"/);
  assert.equal(prompt.includes('Fjordlys Keramikk AS'), true);
  assert.deepEqual(forbidden(prompt), []);
  const withQuote = `${buildCursorPrompt(input)}\n${input.directives[0].quote}`;
  assert.equal(forbidden(withQuote).length, 1);
});

test('a long id list is shortened by whole ids', () => {
  const asks = Array.from({ length: 400 }, (_, index) => ({ id: `ask-${String(index).padStart(4, '0')}-fjordlys` }));
  const prompt = buildCursorPrompt(promptInput({ threadAsks: asks }));
  assert.ok(prompt.length <= CURSOR_PROMPT_MAX_CHARS, `chars ${prompt.length}`);
  assert.match(prompt, /dir-accepted-1/);
  const askLine = prompt.split('\n').find((line) => line.startsWith('Åpne spørsmål:')) || '';
  if (askLine) {
    for (const id of askLine.slice('Åpne spørsmål:'.length).split(',').map((part) => part.trim()).filter(Boolean)) {
      assert.equal(asks.some((row) => row.id === id), true, id);
    }
  }
});

function snapshot(dir) {
  const out = new Map();
  const walk = (current) => {
    if (!existsSync(current)) return;
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else out.set(full, `${info.mtimeMs}:${info.size}`);
    }
  };
  walk(dir);
  return out;
}

function sameSnapshot(before, after) {
  if (before.size !== after.size) return false;
  for (const [key, value] of before) if (after.get(key) !== value) return false;
  return true;
}

test('the cursor prompt route follows the switch and writes nothing when it refuses', { timeout: 180_000 }, async (t) => {
  const hub = await bootHub({}, {
    seed(dir) {
      writeFileSync(join(dir, 'sales-clients.json'), JSON.stringify([{
        id: 'client-fjordlys',
        businessName: 'Fjordlys Keramikk AS',
        product: 'asoldi',
        status: 'active',
        contactEmail: 'post@example.com',
        contactPhone: '+47 000 00 000',
        sitePlan: { status: 'active', tierId: 'tier-1-standard', services: ['site'], pages: 5, billing: 'month' },
        makerRun: { runId: 'run-fjordlys-1' },
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      }]));
    },
  });
  t.after(() => hub.stop());
  assert.ok(hub.health, hub.log().slice(-2000));
  const password = readFileSync(join(hub.dataDir, 'secrets', 'initial-admin-password'), 'utf8').trim();
  const admin = await hub.adminToken('asoldi.com', password);
  assert.ok(admin, hub.log().slice(-2000));
  const url = `${hub.base}/api/admin/development/client-fjordlys/cursor-prompt`;
  const storeFile = join(hub.dataDir, 'sales-clients.json');

  async function refused(headers, status, code) {
    const before = snapshot(hub.dataDir);
    const store = readFileSync(storeFile, 'utf8');
    const response = await fetch(url, { headers });
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    assert.equal(body.code, code);
    assert.equal(readFileSync(storeFile, 'utf8'), store);
    assert.equal(sameSnapshot(before, snapshot(hub.dataDir)), true);
    return 1;
  }

  let requests = 0;
  requests += await refused({}, 404, 'disabled');
  requests += await refused({ authorization: `Bearer ${admin}` }, 404, 'disabled');
  assert.ok(requests > 0, `requests ${requests}`);

  const saved = await fetch(`${hub.base}/api/admin/automation-settings`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
    body: JSON.stringify({ iteration: { cursorPrompt: { enabled: true, mode: 'shadow', paused: null } } }),
  });
  assert.equal(saved.status, 200, await saved.text());

  const created = await fetch(`${hub.base}/api/admin/users`, {
    method: 'POST',
    headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'fjordlys.salg', password: 'Fjordlys-test-pass-1', role: 'sales', phone: '+47 000 00 000' }),
  });
  assert.equal(created.status, 201, await created.text());
  const developer = await fetch(`${hub.base}/api/admin/users`, {
    method: 'POST',
    headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'fjordlys.utvikler', password: 'Fjordlys-test-pass-1', role: 'developer' }),
  });
  assert.equal(developer.status, 201, await developer.text());

  let onRequests = 0;
  onRequests += await refused({}, 401, 'unauthorized');
  const salesLogin = await fetch(`${hub.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'fjordlys.salg', password: 'Fjordlys-test-pass-1' }),
  });
  const salesBody = await salesLogin.json();
  assert.equal(salesLogin.status, 200, JSON.stringify(salesBody));
  const salesToken = salesBody.token;
  onRequests += await refused({ authorization: `Bearer ${salesToken}` }, 403, 'forbidden');
  assert.ok(onRequests > 0, `requests ${onRequests}`);

  const developerLogin = await fetch(`${hub.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'fjordlys.utvikler', password: 'Fjordlys-test-pass-1' }),
  });
  const developerBody = await developerLogin.json();
  assert.equal(developerLogin.status, 200, JSON.stringify(developerBody));
  const developerToken = developerBody.token;
  const ok = await fetch(url, { headers: { authorization: `Bearer ${developerToken}` } });
  const body = await ok.json();
  assert.equal(ok.status, 200, JSON.stringify(body));
  assert.match(body.prompt, /run-fjordlys-1/);
  assert.match(body.prompt, new RegExp(CURSOR_PROMPT_MODEL));
  assert.equal(body.prompt.includes('post@example.com'), false);
  assert.equal(body.prompt.includes('000 00 000'), false);
});
