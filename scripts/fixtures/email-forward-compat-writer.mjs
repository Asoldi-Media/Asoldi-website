// Child process for scripts/email-forward-compat.test.mjs.
// Runs the e-mail store from --code-root (the current tree or an older commit) against
// APP_DATA_DIR and makes the ordinary writes that code makes: a settings change, an owner-routing
// change on a site row, a site key record for another site and one opt-out row. Each runs only
// when that code exports the function; the report lists what ran.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const index = process.argv.indexOf('--code-root');
const codeRoot = index === -1 ? process.cwd() : process.argv[index + 1];
const store = await import(pathToFileURL(join(codeRoot, 'data', 'email-store.js')).href);
const AT = '2026-11-05T12:00:00.000Z';
const done = [];

if (typeof store.saveEmailSettings === 'function') {
  await store.saveEmailSettings({ killSwitch: true });
  done.push('saveEmailSettings');
}
if (typeof store.patchEmailSite === 'function') {
  await store.patchEmailSite('fc-site', { ownerRouting: 'owner', ownerRoutingSetAt: AT, ownerRoutingSetBy: 'superadmin' });
  done.push('patchEmailSite');
}
if (typeof store.patchEmailSecrets === 'function') {
  await store.patchEmailSecrets({ siteKeys: { 'fc-other': { seq: 1 } } });
  done.push('patchEmailSecrets');
}
if (typeof store.updateEmailSuppressions === 'function') {
  await store.updateEmailSuppressions((rows) => {
    rows['fc-other'] = { ...(rows['fc-other'] || {}), 'ny-kunde@example.com': { scope: 'marketing', source: 'unsubscribe-link', at: AT } };
  });
  done.push('updateEmailSuppressions');
}
console.log(JSON.stringify({ ok: true, done }));
