import { existsSync } from 'fs';
import * as sales from '../data/sales.js';
import { listOffers } from '../data/offers.js';
import { getDataFilePath, writeDataJson } from '../data/storage-path.js';
import { saveSignedContract } from './inbox-bot/apply-contract.js';
import { inboundContractAcceptedByEmail, TINY_PDF_BYTES } from './inbox-bot/inspect-contract.js';
import { matchSalesClient } from './inbox-bot/match-client.js';
import { listInboxItems, presentInboxForClient, updateInboxItem } from './inbox-bot/store.js';
import { sendPreWorkshopAfterContractSigned } from './workshop-prep-send.js';

const BACKFILL_STAMP = 'signed-contract-backfill.json';

export function markClientSoldFromSignedContract(clientId) {
  const current = sales.getSalesClientById(clientId);
  if (!current) return null;
  if (current.progression?.contractSigned) return current;
  try {
    const signed = sales.setSalesProgress(clientId, 'contractSigned', true, { fastTrack: true });
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

export function hasPreviewAcceptedContract(salesClientId = '') {
  return listInboxItems({ salesClientId, kind: 'signed_contract' }).some((item) => (
    item.signedVerdict === 'preview_accept' || String(item.messageId || '').startsWith(`preview-${salesClientId}`)
  ));
}

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
  });
}

export function inboxItemShouldAutoAccept(item, client) {
  if (!item?.fileName || !client) return false;
  if (item.status === 'accepted') return false;
  if ((Number(item.inboundBytes) || 0) < TINY_PDF_BYTES) return false;
  return matchSalesClient([client], { from: item.from }).via === 'email';
}

export async function backfillRecognizedSignedContracts({ apply = false } = {}) {
  const results = [];

  for (const offer of listOffers()) {
    if (!offer.acceptance?.acceptedAt || !offer.salesClientId) continue;
    const client = sales.getSalesClientById(offer.salesClientId);
    if (!client) continue;
    const inbox = presentInboxForClient(client.id);
    const needsSold = !client.progression?.contractSigned;
    const needsFile = !hasPreviewAcceptedContract(client.id) && !inbox.signed;
    if (!needsSold && !needsFile) continue;
    results.push({
      id: client.id,
      name: client.businessName,
      source: 'preview',
      needsSold,
      needsFile,
      acceptedAt: offer.acceptance.acceptedAt,
    });
    if (!apply) continue;
    if (needsFile) {
      await storePreviewAcceptedContract(client, {
        email: offer.acceptance.email || offer.targetEmail,
        acceptedAt: offer.acceptance.acceptedAt,
      });
    }
    if (needsSold) markClientSoldFromSignedContract(client.id);
  }

  for (const item of listInboxItems({ kind: 'signed_contract' })) {
    if (item.status === 'accepted' || !item.salesClientId) continue;
    const client = sales.getSalesClientById(item.salesClientId);
    if (!client || !inboxItemShouldAutoAccept(item, client)) continue;
    const needsSold = !client.progression?.contractSigned;
    results.push({
      id: client.id,
      name: client.businessName,
      source: 'inbox',
      needsSold,
      needsFile: false,
      itemId: item.id,
    });
    if (!apply) continue;
    updateInboxItem(item.id, {
      status: 'accepted',
      signedVerdict: item.signedVerdict === 'unsigned' || item.status === 'unsigned_copy' ? 'email' : item.signedVerdict,
      summary: item.summary || 'Signert kontrakt mottatt på e-post.',
    });
    if (needsSold) markClientSoldFromSignedContract(client.id);
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

export { inboundContractAcceptedByEmail };
