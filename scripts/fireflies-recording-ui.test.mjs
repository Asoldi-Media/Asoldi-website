// Sales UI: what the hub says about each booked meeting's Fireflies recording (app/pages/Admin/sections/
// firefliesRecording.ts), and the screens that must show it. The .ts helpers load as-is (Node strips types).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const h = await import(new URL('../app/pages/Admin/sections/firefliesRecording.ts', import.meta.url).href);
const { answerMeansMissingRoute } = await import(new URL('../app/pages/sales/hubRoute.ts', import.meta.url).href);
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const MIN = 60_000;
const START = Date.parse('2026-10-23T10:00:00.000Z'); // 12:00 in Oslo
const at = (minutes) => new Date(START + minutes * MIN).toISOString();
const LINK = 'https://meet.google.com/abc-defg-hij';
const SAFE_MODE = 'Live-join er av på denne huben (safe mode), så Fireflies sendes ikke inn herfra.';

const entry = (patch = {}) => ({
  slotKey: `sales:${START}`, kind: 'sales', startAt: at(0), meetLink: LINK, state: 'scheduled', attempts: 0,
  lastAttemptAt: '', verifiedAt: '', message: 'Fireflies sendes inn i Meet 3 minutter før start.', nextAttemptAt: at(-3),
  canResend: false, sessionKey: `${LINK}|${START}`, title: 'Testfirma AS · Kari Test', lastSeenAt: '', hasTranscript: false, ...patch,
});
const view = (patch, minutesFromStart, bookedMinutes = 60) => h.liveRecordingView(entry(patch), { nowMs: START + minutesFromStart * MIN, bookedMinutes });

test('only the app shell or a 404 page means a route is missing, never a proxy error page', () => {
  assert.equal(answerMeansMissingRoute({ parsed: false, status: 200, method: 'GET' }), true);
  assert.equal(answerMeansMissingRoute({ parsed: false, status: 200 }), true);
  assert.equal(answerMeansMissingRoute({ parsed: false, status: 404, method: 'POST' }), true);
  for (const status of [500, 502, 503, 504]) assert.equal(answerMeansMissingRoute({ parsed: false, status, method: 'GET' }), false, String(status));
  assert.equal(answerMeansMissingRoute({ parsed: false, status: 200, method: 'POST' }), false);
  assert.equal(answerMeansMissingRoute({ parsed: true, status: 404, method: 'GET' }), false);
  assert.match(read('app/pages/sales/emailApi.ts'), /answerMeansMissingRoute\(/);
  // One bad answer must not hide "Møter uten opptak" for the rest of the session.
  assert.doesNotMatch(read('app/pages/Admin/sections/MissingRecordingsPanel.tsx'), /setSupported/);
});
