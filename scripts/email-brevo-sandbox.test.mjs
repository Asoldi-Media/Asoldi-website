// Live Brevo check in sandbox mode (X-Sib-Sandbox: drop: Brevo validates the request and delivers
// nothing). npm test lists it, but it is skipped unless BREVO_SANDBOX_TEST=1, HUB_SAFE_MODE=0 and
// BREVO_API_KEY are all set in the environment; then it runs against https://api.brevo.com:
//
//   BREVO_SANDBOX_TEST=1 BREVO_API_KEY=... HUB_SAFE_MODE=0 node --test scripts/email-brevo-sandbox.test.mjs
//
// It sends one sandboxed email to a reserved example.com address, reads the account, and checks
// that the transactional log delete and unblock paths exist (2xx or 404). It changes no contact,
// list or webhook.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const enabled = process.env.BREVO_SANDBOX_TEST === '1' && process.env.HUB_SAFE_MODE === '0' && Boolean(String(process.env.BREVO_API_KEY || '').trim());
const skip = enabled ? false : 'set BREVO_SANDBOX_TEST=1, HUB_SAFE_MODE=0 and BREVO_API_KEY to run the live sandbox check';

test('Brevo sandbox: send (dropped), account, log-delete and unblock paths', { skip, timeout: 60_000 }, async () => {
  process.env.APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-brevo-sandbox-'));
  const store = await import('../data/email-store.js');
  const brevo = await import('../lib/brevo.js');
  const settings = store.deepMerge(store.readEmailSettings(), { brevo: { sandbox: true } });
  const sent = await brevo.sendBrevoEmail({
    sender: { name: 'Asoldi sandbox', email: settings.sender.defaultAddress },
    to: [{ email: 'sandbox-check@example.com' }],
    subject: 'Sandbox check',
    htmlContent: '<p>Sandbox check</p>',
    textContent: 'Sandbox check',
    headers: { 'X-Mailin-custom': 'site:sandbox|test|em_sandbox' },
    tags: ['cms', 'sandbox', 'test'],
  }, { settings });
  assert.equal(sent.mode, 'sandbox');
  assert.ok(sent.providerMessageId, 'Brevo answered with a messageId');
  const account = await brevo.getBrevoAccount();
  assert.ok(Array.isArray(account.plan));
  const log = await brevo.deleteSmtpLog('sandbox-check@example.com');
  assert.equal(log.ok, true);
  const unblock = await brevo.unblockTransactional('sandbox-check@example.com');
  assert.equal(unblock.ok, true);
});
