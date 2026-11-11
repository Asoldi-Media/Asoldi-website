/**
 * Sends one terms-update notice. Only a staff action calls this (the admin route). No timer does.
 *
 * The kind is emails.termsUpdate (service sender, release-gated, default shadow). Its own mode
 * decides, not the delivery gate:
 *   off / paused  nothing is written
 *   shadow        one safe-mode outbox draft (channel delivery-shadow); the client is not changed
 *   auto          sent through deliverDeliveryEmail (lib/email.js, so safe mode applies), then
 *                 termsNoticePatch records client.ext.legal.notice and the delivery audit gets a row
 */
import { getAutomationSettings } from '../../data/automation-settings.js';
import { getPersistentDataDir } from '../../data/storage-path.js';
import { deliverDeliveryEmail } from '../delivery-emails.js';
import { buildSalesSender } from '../sales-sender.js';
import { spineModeForClient } from '../spine-mode.js';
import { CATALOG_VERSION } from './catalog.js';
import { clientsOnOlderVersions, draftTermsUpdateNotice, termsNoticePatch } from './terms-update.js';

function clean(value) {
  return String(value ?? '').trim();
}

/** off | paused | shadow | auto for emails.termsUpdate on this client. Auto still needs the pilot list. */
export function termsUpdateMode(client, settings) {
  try {
    return spineModeForClient('emails.termsUpdate', client, settings ? { settings } : {});
  } catch {
    return 'off';
  }
}

/** The service mailbox: accountKey `damian` is damian@asoldi.com; reply-to comes from settings. */
function serviceSender(settings) {
  const service = settings?.sender?.service && typeof settings.sender.service === 'object' ? settings.sender.service : {};
  const accountKey = clean(service.accountKey) || 'damian';
  const username = accountKey.includes('@') ? accountKey : `${accountKey}@asoldi.com`;
  const built = buildSalesSender({ username, name: username.split('@')[0] });
  const replyTo = clean(service.replyTo);
  return { from: built.from, replyTo: replyTo || built.replyTo };
}

function pendingForCurrent(client, now) {
  const row = clientsOnOlderVersions([client], { now })[0];
  if (!row) return { eligible: false, pending: false };
  return { eligible: true, pending: Number(row.pendingNotice?.catalogVersion) === CATALOG_VERSION };
}

/**
 * Send or record the notice for one client.
 * Returns { ok, status, code?, mode?, recorded? }.
 * deps: { sales, sendEmail }.
 */
export async function sendTermsUpdateNotice(client, { settings = null, now = new Date(), dataDir, deps = {} } = {}) {
  if (!client?.id) return { ok: false, status: 404, code: 'no-client' };
  const resolved = settings || getAutomationSettings({ dataDir });
  const mode = termsUpdateMode(client, resolved);
  if (mode === 'off' || mode === 'paused') return { ok: false, status: 409, code: mode };
  const gate = pendingForCurrent(client, now);
  if (!gate.eligible || gate.pending) return { ok: false, status: 409, code: 'no-update' };
  const notice = draftTermsUpdateNotice(client, { now });
  const sender = serviceSender(resolved);
  const salesApi = deps.sales;
  const dir = dataDir || getPersistentDataDir();
  let result;
  try {
    result = await deliverDeliveryEmail({
      kindId: 'termsUpdate',
      client,
      message: {
        from: sender.from,
        replyTo: sender.replyTo,
        to: client.contactEmail,
        subject: notice.subject,
        text: notice.text,
        html: notice.html,
      },
      mode: mode === 'auto' ? 'auto' : 'shadow',
      stampKey: '',
      dedupeKey: `termsUpdate:${client.id}:${CATALOG_VERSION}`,
      now,
      dataDir: dir,
      deps: {
        sendEmail: deps.sendEmail,
        alreadySent: async () => {
          const fresh = salesApi?.getSalesClientById?.(client.id) || client;
          return Number(fresh?.ext?.legal?.notice?.catalogVersion) === CATALOG_VERSION;
        },
      },
    });
  } catch {
    return { ok: false, status: 502, code: 'send-failed' };
  }
  if (result.status === 'shadow') return { ok: true, status: 200, mode: 'shadow', recorded: false };
  if (result.status === 'skipped' && result.reason === 'no-recipient') return { ok: false, status: 409, code: 'no-recipient' };
  if (result.status === 'busy') return { ok: false, status: 409, code: 'busy' };
  if (result.status === 'already-sent' || result.status === 'already-recorded') return { ok: false, status: 409, code: 'already-sent' };
  if (result.status !== 'sent') return { ok: false, status: 409, code: 'no-update' };
  const fresh = salesApi.getSalesClientById(client.id);
  const patch = termsNoticePatch(fresh, notice, { now });
  if (patch) salesApi.updateSalesClient(client.id, patch);
  return { ok: true, status: 200, mode: 'auto', recorded: Boolean(patch) };
}
