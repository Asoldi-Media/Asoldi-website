// Opening Meet rooms for the notetaker (lib/google-meet-access.js). The Meet API is always a
// stub; a socket spy refuses anything non-loopback, so no test can reach Google.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-meet-access-'));
process.env.APP_DATA_DIR = dataDir;
Object.assign(process.env, {
  GOOGLE_OAUTH_CLIENT_ID: 'test-client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_OAUTH_REDIRECT_URI: 'http://127.0.0.1:3001/api/admin/sales/google/oauth/callback',
});
delete process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON;

const leakedSockets = [];
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function testNetSpy(...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  const host = String((first && typeof first === 'object' ? first.host : args[1]) || 'localhost');
  if (/^(127\.\d+\.\d+\.\d+|localhost|::1)$/.test(host)) return realConnect.apply(this, args);
  leakedSockets.push(host);
  process.nextTick(() => this.destroy(Object.assign(new Error(`test spy refused ${host}`), { code: 'ETESTLEAK' })));
  return this;
};

const meet = await import('../lib/google-meet-access.js');
const calendar = await import('../lib/google-calendar.js');
const safeMode = await import('../lib/safe-mode.js');
const { clearJsonCacheForTests } = await import('../data/atomic-json.js');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const ROOM = 'https://meet.google.com/abc-defg-hij';
const NOW = Date.parse('2026-10-23T09:30:00.000Z');
const ACCESS_FILE = join(dataDir, 'meet-room-access.json');
const CALENDAR_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ');
const WITH_MEET = `${CALENDAR_SCOPES} ${meet.MEET_SETTINGS_SCOPE}`;

function token(googleEmail, scope = CALENDAR_SCOPES) {
  return { access_token: 'at-test', refresh_token: 'rt-test', googleEmail, scope };
}

function writeTokens(map) {
  writeFileSync(join(dataDir, 'google-calendar-tokens.json'), JSON.stringify(map));
}

/** Meet v2 spaces stub: remembers calls, and a patch really opens the room. */
function fakeMeet({ accessType = 'TRUSTED', getError = null, patchError = null, keepAccess = '', gate = null } = {}) {
  const calls = [];
  let current = accessType;
  return {
    calls,
    kinds: () => calls.map((call) => call.kind),
    spaces: {
      async get(params, options) {
        calls.push({ kind: 'get', params, options });
        if (gate) await gate;
        if (getError) throw getError;
        return { data: { name: 'spaces/sp-test-1', meetingCode: params.name.slice('spaces/'.length), config: { accessType: current } } };
      },
      async patch(params, options) {
        calls.push({ kind: 'patch', params, options });
        if (patchError) throw patchError;
        current = keepAccess || params.requestBody.config.accessType;
        return { data: { name: params.name, config: { accessType: current } } };
      },
    },
  };
}

function googleError(status, { message = 'Google said no', reason = '' } = {}) {
  return Object.assign(new Error(message), {
    status,
    response: {
      status,
      data: { error: { code: status, message, details: reason ? [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] : [] } },
    },
  });
}

test.beforeEach(() => {
  rmSync(ACCESS_FILE, { force: true });
  clearJsonCacheForTests();
  meet.resetMeetRoomAccessForTests();
  writeTokens({});
});

test('meeting codes come only from meet.google.com room links', () => {
  assert.equal(meet.meetingCodeFromLink(ROOM), 'abc-defg-hij');
  assert.equal(meet.meetingCodeFromLink('https://meet.google.com/ABC-DEFG-HIJ?authuser=1'), 'abc-defg-hij');
  assert.equal(meet.meetingCodeFromLink(' meet.google.com/abc-defg-hij/ '), 'abc-defg-hij');
  assert.equal(meet.meetingCodeFromLink('https://meet.google.com/abc-defg-hijk'), '');
  assert.equal(meet.meetingCodeFromLink('https://meet.google.com/safe-mode'), '');
  assert.equal(meet.meetingCodeFromLink('https://meet.google.com/lookup/asoldi'), '');
  assert.equal(meet.meetingCodeFromLink('https://meet.google.com.example.com/abc-defg-hij'), '');
  assert.equal(meet.meetingCodeFromLink('https://example.com/meet.google.com/abc-defg-hij'), '');
  assert.equal(meet.meetingCodeFromLink('abc-defg-hij'), '');
  assert.equal(meet.meetingCodeFromLink(''), '');
});

test('the Meet settings scope is read from a scope string, a list or a token', () => {
  assert.equal(meet.tokenHasMeetSettingsScope(WITH_MEET), true);
  assert.equal(meet.tokenHasMeetSettingsScope({ scope: WITH_MEET }), true);
  assert.equal(meet.tokenHasMeetSettingsScope([meet.MEET_SETTINGS_SCOPE]), true);
  assert.equal(meet.tokenHasMeetSettingsScope(CALENDAR_SCOPES), false);
  assert.equal(meet.tokenHasMeetSettingsScope('https://www.googleapis.com/auth/meetings.space.created'), false);
  assert.equal(meet.tokenHasMeetSettingsScope('https://www.googleapis.com/auth/meetings.space.readonly'), false);
  assert.equal(meet.tokenHasMeetSettingsScope({}), false);
  assert.equal(meet.tokenHasMeetSettingsScope(null), false);
});

test('a room that is already open is read and left alone', async () => {
  const api = fakeMeet({ accessType: 'OPEN' });
  const result = await meet.openMeetRoom({ meetLink: ROOM, meetApi: api, nowMs: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.accessType, 'OPEN');
  assert.equal(result.changed, false);
  assert.equal(result.checkedAt, '2026-10-23T09:30:00.000Z');
  assert.deepEqual(api.kinds(), ['get']);
  assert.equal(api.calls[0].params.name, 'spaces/abc-defg-hij');
  assert.equal(api.calls[0].options.timeout, 4000);
});

test('a trusted or restricted room is patched open by its space name', async () => {
  for (const accessType of ['TRUSTED', 'RESTRICTED']) {
    const api = fakeMeet({ accessType });
    const result = await meet.openMeetRoom({ meetLink: ROOM, meetApi: api, nowMs: NOW });
    assert.equal(result.ok, true, accessType);
    assert.equal(result.changed, true);
    assert.equal(result.accessType, 'OPEN');
    assert.deepEqual(api.kinds(), ['get', 'patch']);
    assert.deepEqual(api.calls[1].params, {
      name: 'spaces/sp-test-1',
      updateMask: 'config.accessType',
      requestBody: { config: { accessType: 'OPEN' } },
    });
  }
});

test('Google refusals come back as soft reasons, never as throws', async () => {
  const outcome = (options) => meet.openMeetRoom({ meetLink: ROOM, meetApi: fakeMeet(options), nowMs: NOW });

  const forbidden = await outcome({ getError: googleError(403, { message: 'The caller does not have permission' }) });
  assert.deepEqual([forbidden.ok, forbidden.reason], [false, 'forbidden']);
  assert.match(forbidden.message, /caller does not have permission/);

  const notOwner = await outcome({ patchError: googleError(403) });
  assert.deepEqual([notOwner.reason, notOwner.accessType], ['not-owner', 'TRUSTED']);

  assert.equal((await outcome({ getError: googleError(404) })).reason, 'not-found');
  assert.equal((await outcome({ getError: googleError(403, { reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', message: 'Request had insufficient authentication scopes.' }) })).reason, 'scope-missing');

  const disabled = await outcome({ getError: googleError(403, { reason: 'SERVICE_DISABLED', message: 'Google Meet REST API has not been used in project 1 before or it is disabled.' }) });
  assert.equal(disabled.reason, 'forbidden');
  assert.match(disabled.message, /Google Meet REST API er ikke slått på/);

  assert.equal((await outcome({ patchError: googleError(400, { message: 'Invalid access type.' }) })).reason, 'forbidden');
  assert.equal((await outcome({ getError: googleError(401) })).reason, 'forbidden');
  assert.equal((await outcome({ getError: googleError(503) })).reason, 'error');
  assert.equal((await outcome({ getError: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) })).reason, 'error');

  const kept = await outcome({ keepAccess: 'TRUSTED' });
  assert.deepEqual([kept.ok, kept.reason, kept.accessType], [false, 'forbidden', 'TRUSTED']);

  const stalled = await meet.openMeetRoom({
    meetLink: ROOM,
    meetApi: { spaces: { get: () => new Promise(() => {}) } },
    timeoutMs: 20,
    nowMs: NOW,
  });
  assert.deepEqual([stalled.ok, stalled.reason], [false, 'error']);
  assert.match(stalled.message, /svarte ikke i tide/);

  const broken = await meet.openMeetRoom({
    meetLink: ROOM,
    meetApi: { spaces: { get: () => { throw new Error('client exploded'); } } },
    nowMs: NOW,
  });
  assert.equal(broken.reason, 'error');

  const notARoom = await meet.openMeetRoom({ meetLink: 'https://zoom.example.com/j/1', meetApi: fakeMeet(), nowMs: NOW });
  assert.deepEqual([notARoom.ok, notARoom.reason, notARoom.meetingCode], [false, 'error', '']);
});

test('safe mode blocks the Meet call, records a calendarWrite intent, and lets it through when allowed', async () => {
  safeMode.installSafeMode({ env: { ...process.env, HUB_SAFE_MODE: '1', HUB_SAFE_MODE_ALLOW: '' }, dataDir, log: null, egress: false });
  try {
    const api = fakeMeet();
    const blocked = await meet.openMeetRoom({ meetLink: ROOM, meetApi: api, nowMs: NOW });
    assert.deepEqual([blocked.ok, blocked.reason], [false, 'safe-mode']);
    writeTokens({ 'admin:alexander@asoldi.com': token('alexander@asoldi.com', WITH_MEET) });
    const ensured = await meet.ensureMeetRoomOpen({ meetLink: ROOM, accountKey: 'admin:alexander@asoldi.com', nowMs: NOW, deps: { meetApi: api } });
    assert.equal(ensured.reason, 'safe-mode');
    assert.equal(api.calls.length, 0, 'nothing reached the Meet API');
    const intents = safeMode.readRecentIntents(50).filter((row) => row.kind === 'calendarWrite');
    assert.ok(intents.some((row) => /meet\.spaces\.patch code=abc-defg-hij/.test(row.detail)));

    safeMode.installSafeMode({ env: { ...process.env, HUB_SAFE_MODE: '1', HUB_SAFE_MODE_ALLOW: 'calendarWrite' }, dataDir, log: null, egress: false });
    const allowed = await meet.openMeetRoom({ meetLink: ROOM, meetApi: api, nowMs: NOW });
    assert.equal(allowed.ok, true);
  } finally {
    safeMode.resetSafeModeForTests();
  }
});

test('without an OAuth token that carries the scope, Google is never called', async () => {
  const api = fakeMeet();
  const none = await meet.ensureMeetRoomOpen({ meetLink: ROOM, accountKey: 'sales:rep-1', nowMs: NOW, deps: { meetApi: api } });
  assert.deepEqual([none.ok, none.reason, none.cached], [false, 'scope-missing', false]);

  writeTokens({ 'sales:rep-1': token('alexander@asoldi.com') });
  const noScope = await meet.ensureMeetRoomOpen({ meetLink: ROOM, accountKey: 'sales:rep-1', nowMs: NOW + 1000, deps: { meetApi: api } });
  assert.deepEqual([noScope.reason, noScope.ownerKey, noScope.cached], ['scope-missing', 'sales:rep-1', false]);
  assert.match(noScope.message, /koble til Google på nytt/i);
  assert.equal(api.calls.length, 0);

  // A remembered mailbox with no token of its own (service account only) is no OAuth login either.
  writeTokens({});
  calendar.rememberCalendarAccountEmail('sales:rep-2', 'alexander@asoldi.com');
  const subjectOnly = await meet.ensureMeetRoomOpen({ meetLink: 'https://meet.google.com/zzz-yyyy-xxx', accountKey: 'sales:rep-2', nowMs: NOW, deps: { meetApi: api } });
  assert.equal(subjectOnly.reason, 'scope-missing');
  assert.match(subjectOnly.message, /alexander@asoldi\.com har ikke koblet til Google/);

  const stored = JSON.parse(readFileSync(ACCESS_FILE, 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), ['abc-defg-hij', 'zzz-yyyy-xxx']);
  assert.deepEqual(Object.keys(stored['abc-defg-hij']).sort(), ['accessType', 'checkedAt', 'message', 'ok', 'ownerKey', 'reason']);
  assert.equal(stored['abc-defg-hij'].reason, 'scope-missing');
  assert.equal(api.calls.length, 0);
});

test('a scoped token opens the room, the result is stored, and an open room is not asked about for 6 hours', async () => {
  writeTokens({ 'sales:rep-1': token('alexander@asoldi.com', WITH_MEET) });
  const api = fakeMeet({ accessType: 'TRUSTED' });
  const ensure = (extra = {}) => meet.ensureMeetRoomOpen({ meetLink: ROOM, accountKey: 'sales:rep-1', deps: { meetApi: api }, ...extra });

  const first = await ensure({ nowMs: NOW });
  assert.deepEqual([first.ok, first.accessType, first.cached, first.ownerKey], [true, 'OPEN', false, 'sales:rep-1']);
  assert.deepEqual(api.kinds(), ['get', 'patch']);
  assert.deepEqual(meet.meetRoomAccessStatus(`${ROOM}?authuser=0`), {
    meetingCode: 'abc-defg-hij',
    ok: true,
    accessType: 'OPEN',
    reason: '',
    message: first.message,
    checkedAt: '2026-10-23T09:30:00.000Z',
    ownerKey: 'sales:rep-1',
  });

  const soon = await ensure({ nowMs: NOW + 60_000 });
  assert.deepEqual([soon.ok, soon.cached], [true, true]);
  assert.equal(api.calls.length, 2, 'no Google call within 6 hours');

  const forced = await ensure({ nowMs: NOW + 120_000, force: true });
  assert.equal(forced.cached, false);
  assert.deepEqual(api.kinds(), ['get', 'patch', 'get'], 'force reads again, and an open room is not patched');

  const later = await ensure({ nowMs: NOW + 120_000 + meet.MEET_ROOM_OPEN_TTL_MS + 1000 });
  assert.equal(later.cached, false);
  assert.equal(api.calls.length, 4);
  assert.equal(meet.meetRoomAccessStatus('https://example.com/not-a-room'), null);
});

test('a room Google refused is asked about again only after 15 minutes', async () => {
  writeTokens({ 'sales:rep-1': token('alexander@asoldi.com', WITH_MEET) });
  const api = fakeMeet({ patchError: googleError(403) });
  const ensure = (nowMs) => meet.ensureMeetRoomOpen({ meetLink: ROOM, accountKey: 'sales:rep-1', nowMs, deps: { meetApi: api } });
  assert.equal((await ensure(NOW)).reason, 'not-owner');
  const again = await ensure(NOW + 60_000);
  assert.deepEqual([again.reason, again.cached], ['not-owner', true]);
  assert.equal(api.calls.length, 2);
  await ensure(NOW + meet.MEET_ROOM_REFUSED_RETRY_MS + 1000);
  assert.equal(api.calls.length, 4);
});

test('the owner mailbox token with the scope wins over a stale alias token', async () => {
  writeTokens({
    'sales:rep-1': token('alexander@asoldi.com'),
    'admin:alexander@asoldi.com': token('alexander@asoldi.com', WITH_MEET),
    'admin:damian@asoldi.com': token('damian@asoldi.com', WITH_MEET),
    'admin:asoldi.com': token('contact@asoldi.com', WITH_MEET),
  });
  assert.deepEqual(calendar.meetRoomOwnerToken({ accountKey: 'sales:rep-1' }), {
    accountKey: 'admin:alexander@asoldi.com',
    googleEmail: 'alexander@asoldi.com',
    scope: WITH_MEET,
    usable: true,
  });
  assert.equal(calendar.meetRoomOwnerToken({ accountKey: 'admin:damian@asoldi.com', ownerEmail: 'alexander@asoldi.com' }).accountKey, 'admin:alexander@asoldi.com');
  assert.equal(calendar.meetRoomOwnerToken({ ownerEmail: 'contact@asoldi.com' }).usable, false, 'a shared mailbox never hosts');
  assert.equal(calendar.meetRoomOwnerToken({ ownerEmail: 'nobody@example.com' }).usable, false);

  const api = fakeMeet();
  const opened = await meet.ensureMeetRoomOpen({ meetLink: ROOM, accountKey: 'sales:rep-1', nowMs: NOW, deps: { meetApi: api } });
  assert.deepEqual([opened.ok, opened.ownerKey], [true, 'admin:alexander@asoldi.com']);
});

test('only the owner’s own OAuth login may open a room', async () => {
  const api = fakeMeet();
  const fakeCalendar = {
    meetRoomOwnerToken: () => ({ accountKey: 'sales:rep-1', googleEmail: 'alexander@asoldi.com', scope: WITH_MEET, usable: true }),
    getAuthorizedClient: async () => ({ authMode: 'shared', oauthClient: {} }),
  };
  const shared = await meet.ensureMeetRoomOpen({ meetLink: ROOM, nowMs: NOW, deps: { calendar: fakeCalendar, meetApi: api } });
  assert.equal(shared.reason, 'scope-missing');
  assert.equal(api.calls.length, 0);

  const failingLogin = { ...fakeCalendar, getAuthorizedClient: async () => { throw new Error('google-token-timeout'); } };
  const login = await meet.ensureMeetRoomOpen({ meetLink: ROOM, nowMs: NOW, deps: { calendar: failingLogin, meetApi: api } });
  assert.equal(login.reason, 'error');
  assert.match(login.message, /google-token-timeout/);
});

test('ensure never rejects and never stores a link that is not a room', async () => {
  const broken = { meetRoomOwnerToken: () => { throw new Error('tokens unreadable'); } };
  const result = await meet.ensureMeetRoomOpen({ meetLink: ROOM, nowMs: NOW, deps: { calendar: broken } });
  assert.deepEqual([result.ok, result.reason, result.cached], [false, 'error', false]);
  assert.match(result.message, /tokens unreadable/);

  const zoom = await meet.ensureMeetRoomOpen({ meetLink: 'https://zoom.example.com/j/1', nowMs: NOW });
  assert.deepEqual([zoom.ok, zoom.reason, zoom.meetingCode], [false, 'error', '']);
  assert.equal(meet.meetRoomAccessStatus('https://zoom.example.com/j/1'), null);
});

test('two checks of the same room at once share one Google round trip', async () => {
  writeTokens({ 'sales:rep-1': token('alexander@asoldi.com', WITH_MEET) });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const api = fakeMeet({ gate });
  const input = { meetLink: ROOM, accountKey: 'sales:rep-1', nowMs: NOW, deps: { meetApi: api } };
  const both = Promise.all([meet.ensureMeetRoomOpen(input), meet.ensureMeetRoomOpen({ ...input, force: true })]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  const [a, b] = await both;
  assert.equal(a.ok && b.ok, true);
  assert.deepEqual(api.kinds(), ['get', 'patch']);
});

test('the background opener settles quietly', async () => {
  const task = meet.openMeetRoomSoon({ meetLink: ROOM, accountKey: 'sales:nobody' });
  await meet.settleMeetRoomOpensForTests();
  assert.equal((await task).reason, 'scope-missing');
});

test('Google status says whether the mailbox can open its rooms', () => {
  writeTokens({ 'sales:rep-1': token('alexander@asoldi.com') });
  assert.equal(calendar.getGoogleCalendarStatus('sales:rep-1').meetSettingsScope, false);
  writeTokens({ 'sales:rep-1': token('alexander@asoldi.com', WITH_MEET) });
  assert.equal(calendar.getGoogleCalendarStatus('sales:rep-1').meetSettingsScope, true);
  // A reconnect lands on the mailbox key; the alias key sees it too.
  writeTokens({
    'sales:rep-1': token('alexander@asoldi.com'),
    'admin:alexander@asoldi.com': token('alexander@asoldi.com', WITH_MEET),
  });
  assert.equal(calendar.getGoogleCalendarStatus('sales:rep-1').meetSettingsScope, true);
  writeTokens({});
  const missing = calendar.getGoogleCalendarStatus('sales:nobody');
  assert.deepEqual([missing.connected, missing.meetSettingsScope], [false, false]);
});

test('Connect asks for the Meet settings scope and keeps what was granted before', () => {
  const url = new URL(calendar.createGoogleCalendarAuthUrl('state-test'));
  const scopes = url.searchParams.get('scope').split(' ');
  assert.ok(scopes.includes(meet.MEET_SETTINGS_SCOPE));
  assert.ok(scopes.includes('https://www.googleapis.com/auth/calendar.events'));
  assert.equal(scopes.some((scope) => scope.endsWith('meetings.space.created')), false);
  assert.equal(url.searchParams.get('include_granted_scopes'), 'true');
  assert.equal(url.searchParams.get('access_type'), 'offline');
});

test('no test request leaked past the stubs to a real socket', () => {
  assert.deepEqual(leakedSockets, []);
});
