import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { google } from 'googleapis';
import {
  GOOGLE_REQUEST_DEADLINE_MS,
  applyGoogleRequestDeadline,
} from '../lib/google-request-deadline.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

test('Google OAuth clients abort instead of holding a socket for the OS timeout', () => {
  assert.equal(GOOGLE_REQUEST_DEADLINE_MS, 8000);
  const client = new google.auth.OAuth2('id', 'secret', 'https://asoldi.com/callback');
  applyGoogleRequestDeadline(client);
  assert.equal(client.transporter.defaults.timeout, 8000);

  const calendarSrc = readFileSync(join(root, 'lib/google-calendar.js'), 'utf8');
  const createStart = calendarSrc.indexOf('function createOAuthClient');
  const createBody = calendarSrc.slice(createStart, calendarSrc.indexOf('function readTokensMap'));
  assert.match(createBody, /applyGoogleRequestDeadline/);

  const gmail = readFileSync(join(root, 'lib/gmail-readonly.js'), 'utf8');
  assert.match(gmail, /GOOGLE_REQUEST_DEADLINE_MS/);
  assert.match(gmail, /Date\.now\(\) - started >= GOOGLE_REQUEST_DEADLINE_MS/);
});
