import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-cal-ws-'));
process.env.APP_DATA_DIR = dataDir;
delete process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON;

const {
  createSharedCalendarJwt,
  createWorkspaceJwt,
  getAuthorizedClient,
  getGoogleCalendarStatus,
  googleWorkspaceCalendarScopes,
  listConnectedAsoldiCalendarSources,
  loadSalesCalendarWeek,
  persistGoogleMailboxToken,
  rememberCalendarAccountEmail,
  resolveCalendarSyncAccountKey,
  shareGoogleCalendarToken,
  workspaceServiceAccountConfigured,
  workspaceSubjectEmail,
} = await import('../lib/google-calendar.js');

const FAKE_SA = JSON.stringify({
  client_email: 'asoldi-calendar@example.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n',
});

test('admin account keys map to the owned mailbox', () => {
  assert.equal(workspaceSubjectEmail('admin:alexander@asoldi.com'), 'alexander@asoldi.com');
  assert.equal(workspaceSubjectEmail('admin:contact@asoldi.com'), '');
});

test('remembered sales keys impersonate that @asoldi.com mailbox', () => {
  assert.equal(rememberCalendarAccountEmail('sales:rep-1', 'alexander@asoldi.com'), 'alexander@asoldi.com');
  assert.equal(workspaceSubjectEmail('sales:rep-1'), 'alexander@asoldi.com');
  assert.equal(rememberCalendarAccountEmail('sales:rep-2', 'contact@asoldi.com'), '');
});

test('workspace jwt impersonates the mailbox without a user oauth click', () => {
  process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON = FAKE_SA;
  assert.equal(workspaceServiceAccountConfigured(), true);
  const jwt = createWorkspaceJwt('alexander@asoldi.com');
  assert.ok(jwt);
  assert.equal(jwt.subject, 'alexander@asoldi.com');
  assert.equal(jwt.email, 'asoldi-calendar@example.iam.gserviceaccount.com');
  assert.equal(createWorkspaceJwt('contact@asoldi.com'), null);
  const shared = createSharedCalendarJwt();
  assert.ok(shared);
  assert.equal(shared.subject || '', '');
  assert.equal(shared.email, 'asoldi-calendar@example.iam.gserviceaccount.com');
  delete process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON;
});

test('status is connected for a remembered mailbox when the service account is set', () => {
  process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON = FAKE_SA;
  rememberCalendarAccountEmail('sales:rep-1', 'alexander@asoldi.com');
  const status = getGoogleCalendarStatus('sales:rep-1');
  assert.equal(status.connected, true);
  assert.equal(status.googleEmail, 'alexander@asoldi.com');
  assert.equal(resolveCalendarSyncAccountKey({ ownerId: 'sales:rep-1' }), 'sales:rep-1');
  delete process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON;
});

test('missing oauth and missing workspace still throw the same disconnected error', async () => {
  delete process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON;
  await assert.rejects(
    () => getAuthorizedClient('sales:nobody'),
    /Google Calendar account is not connected yet/
  );
});

test('oauth token for the same mailbox is copied onto the sales key', () => {
  writeFileSync(join(dataDir, 'google-calendar-tokens.json'), JSON.stringify({
    'admin:alexander@asoldi.com': {
      refresh_token: 'rt',
      access_token: 'at',
      googleEmail: 'alexander@asoldi.com',
    },
  }));
  const shared = shareGoogleCalendarToken('admin:alexander@asoldi.com', ['sales:rep-1']);
  assert.equal(shared.shared, true);
  assert.equal(getGoogleCalendarStatus('sales:rep-1').connected, true);
  assert.equal(getGoogleCalendarStatus('sales:rep-1').googleEmail, 'alexander@asoldi.com');
});

test('sales login reuses the admin oauth token for that mailbox without Connect', () => {
  writeFileSync(join(dataDir, 'google-calendar-tokens.json'), JSON.stringify({
    'admin:asoldi.com': {
      refresh_token: 'rt-alex',
      access_token: 'at-alex',
      googleEmail: 'alexander@asoldi.com',
    },
  }));
  rememberCalendarAccountEmail('sales:1789355644760', 'alexander@asoldi.com');
  const status = getGoogleCalendarStatus('sales:1789355644760');
  assert.equal(status.connected, true);
  assert.equal(status.googleEmail, 'alexander@asoldi.com');
  assert.equal(resolveCalendarSyncAccountKey({ ownerId: 'sales:1789355644760' }), 'sales:1789355644760');
});

test('connecting a second mailbox keeps the first mailbox token', () => {
  writeFileSync(join(dataDir, 'google-calendar-tokens.json'), JSON.stringify({
    'admin:asoldi.com': {
      refresh_token: 'rt-alex',
      access_token: 'at-alex',
      googleEmail: 'alexander@asoldi.com',
    },
  }));
  persistGoogleMailboxToken('admin:asoldi.com', {
    refresh_token: 'rt-damian',
    access_token: 'at-damian',
    googleEmail: 'damian@asoldi.com',
  });
  assert.equal(getGoogleCalendarStatus('admin:alexander@asoldi.com').googleEmail, 'alexander@asoldi.com');
  assert.equal(getGoogleCalendarStatus('admin:damian@asoldi.com').googleEmail, 'damian@asoldi.com');
  const emails = listConnectedAsoldiCalendarSources().map((row) => row.googleEmail).sort();
  assert.deepEqual(emails, ['alexander@asoldi.com', 'damian@asoldi.com']);
});

test('two week reads at once are not rejected as busy', async () => {
  const range = { timeMin: '2026-10-19T00:00:00.000Z', timeMax: '2026-10-26T00:00:00.000Z' };
  const [first, second] = await Promise.all([
    loadSalesCalendarWeek({ sources: [], ...range }),
    loadSalesCalendarWeek({ sources: [], ...range }),
  ]);
  assert.equal((first.warnings || []).join('').includes('opptatt'), false);
  assert.equal((second.warnings || []).join('').includes('opptatt'), false);
});

test('service account json may be pretty-printed or wrapped in extra quotes', () => {
  process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON = JSON.stringify(FAKE_SA);
  assert.equal(workspaceServiceAccountConfigured(), true);
  process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON = JSON.stringify(JSON.parse(FAKE_SA), null, 2);
  assert.equal(workspaceServiceAccountConfigured(), true);
  process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON = `"${FAKE_SA}"`;
  assert.equal(workspaceServiceAccountConfigured(), true);
  delete process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON;
});

test('workspace scopes are calendar write, not an API key', () => {
  const scopes = googleWorkspaceCalendarScopes();
  assert.ok(scopes.includes('https://www.googleapis.com/auth/calendar.events'));
  assert.equal(scopes.some((scope) => scope.includes('gmail')), false);
});

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON;
});
