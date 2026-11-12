import { existsSync } from 'fs';
import * as sales from '../data/sales.js';
import { listOffers } from '../data/offers.js';
import { getDataFilePath, writeDataJson } from '../data/storage-path.js';
import { resolveInboxContractPath, saveSignedContract } from './inbox-bot/apply-contract.js';
import { decideInboundContract, hasPreviewAcceptedContract } from './inbox-bot/inspect-contract.js';
import { matchSalesClient } from './inbox-bot/match-client.js';
import { pdfLooksLikeAsoldiContract } from './inbox-bot/pdf-text.js';
import { listInboxItems, presentInboxForClient, updateInboxItem } from './inbox-bot/store.js';
import { sendPreWorkshopAfterContractSigned } from './workshop-prep-send.js';

const BACKFILL_STAMP = 'signed-contract-backfill.json';

/** Preview/portal accept creates the kundeprofil; stamp that on the sales card so Solgt shows the user, not a PDF. */
export function linkSalesClientPortalFromAcceptance(client, acceptance = {}) {
  const userId = String(acceptance.userId || '').trim();
  if (!client?.id || !userId || String(client.portalUserId || '').trim()) return client;
  return sales.updateSalesClient(client.id, {
    portalUserId: userId,
    portalBusinessId: client.portalBusinessId || userId,
    portalConnectedAt: client.portalConnectedAt || acceptance.acceptedAt || new Date().toISOString(),
    clientEmail: client.clientEmail || String(acceptance.email || '').trim(),
  }) || client;
}

export function backfillPortalUsersFromAcceptances() {
  let linked = 0;
  for (const offer of listOffers()) {
    if (!offer.acceptance?.userId || !offer.salesClientId) continue;
    const client = sales.getSalesClientById(offer.salesClientId);
    if (!client || client.portalUserId) continue;
    if (linkSalesClientPortalFromAcceptance(client, offer.acceptance)?.portalUserId) linked += 1;
  }
  return linked;
}

/**
 * Tick Solgt. Without fastTrack (an emailed PDF) a card that has not had Møte + Tilbud stays where it is
 * and the blocked reason is logged. `fastTrack: true` only for an explicit e-signature (portal or preview
 * acceptance), which ticks Møte and Tilbud with it. Returns the fresh card, or the unchanged one when blocked.
 */
export function markClientSoldFromSignedContract(clientId, { fastTrack = false } = {}) {
  const current = sales.getSalesClientById(clientId);
  if (!current) return null;
  if (current.progression?.contractSigned) return current;
  try {
    const signed = sales.setSalesProgress(clientId, 'contractSigned', true, { fastTrack: Boolean(fastTrack) });
    if (signed) {
      sendPreWorkshopAfterContractSigned(signed, { previousSigned: false }).catch((error) => {
        console.error('[signed-contract] pre-workshop email failed', clientId, error?.message || error);
      });
    }
    return signed;
  } catch (error) {
    console.error('[signed-contract] set Solgt failed', clientId, error?.message || error);
    return current;
  }
}

async function buildClientContractPdf(client) {
  if (!client?.id) return null;
  try {
    const { getOfferForClient } = await import('../data/sales-offers.js');
    const { buildContractPdf, contractFileName, contractInputsForOffer, offerContractIsAvailable } = await import('./offer-contract-pdf.js');
    const { clientWithOfferParty } = await import('./offer-readiness.js');
    const offer = getOfferForClient(client.id);
    if (!offer || !offerContractIsAvailable(offer)) return null;
    const dateRaw = client.contractSignedAt || client.contractSentAt || offer.sentAt;
    const date = dateRaw ? new Date(dateRaw) : new Date();
    const view = clientWithOfferParty(client, offer, {});
    const buffer = await buildContractPdf({
      client: view,
      ...contractInputsForOffer(offer, client),
      date: Number.isNaN(date.getTime()) ? new Date() : date,
    });
    return { buffer, fileName: contractFileName({ client: view, tierId: offer.tierId }) };
  } catch {
    return null;
  }
}

export { hasPreviewAcceptedContract };

export async function storePreviewAcceptedContract(client, { email = '', acceptedAt = '' } = {}) {
  if (!client?.id) return null;
  if (hasPreviewAcceptedContract(client.id)) {
    return listInboxItems({ salesClientId: client.id, kind: 'signed_contract' }).find((item) => (
      item.signedVerdict === 'preview_accept' || String(item.messageId || '').startsWith(`preview-${client.id}`)
    )) || null;
  }
  const built = await buildClientContractPdf(client);
  if (!built?.buffer?.length) return null;
  return saveSignedContract({
    salesClientId: client.id,
    mailbox: 'preview-accept',
    messageId: `preview-${client.id}`,
    from: email,
    subject: 'Signert på forhåndsvisningen',
    summary: 'Signert på forhåndsvisningen.',
    receivedAt: acceptedAt || new Date().toISOString(),
    originalName: built?.fileName || 'signert-kontrakt.pdf',
    buffer: built?.buffer,
    status: 'accepted',
    signedVerdict: 'preview_accept',
    signedReasons: ['preview-accept'],
    inboundBytes: built?.buffer?.length || 0,
    dedupe: false,
  });
}

/** What intake saw, rebuilt from a stored item (items filed before isAsoldiContract was kept fall back to the file name). */
function inspectionFromItem(item = {}) {
  const reasons = Array.isArray(item.signedReasons) ? item.signedReasons : [];
  return {
    isAsoldiContract: typeof item.isAsoldiContract === 'boolean'
      ? item.isAsoldiContract
      : pdfLooksLikeAsoldiContract('', item.fileName),
    verdict: String(item.signedVerdict || ''),
    reasons,
    shaMatch: reasons.includes('identical-to-sent'),
    clientBlock: reasons.includes('no-client-block') ? false : null,
    inboundBytes: Number(item.inboundBytes) || 0,
  };
}

/** Backfill gate: the same decideInboundContract rule as live intake, on a stored item whose file still exists. */
export function inboxItemShouldAutoAccept(item, client) {
  if (!item?.fileName || !client?.id) return false;
  if (item.status === 'accepted') return false;
  if (!resolveInboxContractPath(client.id, item.fileName)) return false;
  const matched = matchSalesClient([client], { from: item.from });
  return decideInboundContract({ client, matched, inspection: inspectionFromItem(item) }).markSold;
}

/**
 * Repair Solgt and the stored PDF. A portal/preview acceptance is the client's own e-signature, so it
 * ticks Solgt with fastTrack; an emailed PDF only through the same decideInboundContract gates as intake.
 */
export async function backfillRecognizedSignedContracts({ apply = false } = {}) {
  const results = [];

  for (const offer of listOffers()) {
    if (!offer.acceptance?.acceptedAt || !offer.salesClientId) continue;
    const client = sales.getSalesClientById(offer.salesClientId);
    if (!client) continue;
    const inbox = presentInboxForClient(client.id);
    const needsSold = !client.progression?.contractSigned;
    const needsFile = !hasPreviewAcceptedContract(client.id) && !inbox.signed;
    const needsPortal = Boolean(offer.acceptance.userId) && !client.portalUserId;
    if (!needsSold && !needsFile && !needsPortal) continue;
    const row = {
      id: client.id,
      name: client.businessName,
      source: 'preview',
      needsSold,
      needsFile,
      needsPortal,
      acceptedAt: offer.acceptance.acceptedAt,
    };
    results.push(row);
    if (!apply) continue;
    if (needsFile) {
      await storePreviewAcceptedContract(client, {
        email: offer.acceptance.email || offer.targetEmail,
        acceptedAt: offer.acceptance.acceptedAt,
      });
    }
    if (needsPortal) linkSalesClientPortalFromAcceptance(client, offer.acceptance);
    if (needsSold && !markClientSoldFromSignedContract(client.id, { fastTrack: true })?.progression?.contractSigned) {
      row.needsSold = false;
      row.blocked = 'mark-blocked';
    }
  }

  for (const item of listInboxItems({ kind: 'signed_contract' })) {
    if (item.status === 'accepted' || !item.salesClientId) continue;
    const client = sales.getSalesClientById(item.salesClientId);
    if (!client || !inboxItemShouldAutoAccept(item, client)) continue;
    const row = {
      id: client.id,
      name: client.businessName,
      source: 'inbox',
      needsSold: true,
      needsFile: false,
      itemId: item.id,
    };
    results.push(row);
    if (!apply) continue;
    // Accept the item only when the card really ticked Solgt.
    if (!markClientSoldFromSignedContract(client.id)?.progression?.contractSigned) {
      row.needsSold = false;
      row.blocked = 'mark-blocked';
      continue;
    }
    updateInboxItem(item.id, {
      status: 'accepted',
      reason: 'signed',
      notified: false,
      summary: 'Signert kontrakt mottatt på e-post — markert Solgt.',
    });
  }

  return {
    apply,
    count: results.length,
    sold: results.filter((row) => row.needsSold).length,
    files: results.filter((row) => row.needsFile).length,
    results,
  };
}

export async function runSignedContractBackfillOnce() {
  backfillPortalUsersFromAcceptances();
  const stamp = getDataFilePath(BACKFILL_STAMP);
  if (existsSync(stamp)) return { skipped: true };
  const result = await backfillRecognizedSignedContracts({ apply: true });
  writeDataJson(stamp, {
    doneAt: new Date().toISOString(),
    sold: result.sold,
    files: result.files,
    count: result.count,
  });
  return result;
}
