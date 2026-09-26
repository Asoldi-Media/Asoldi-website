import * as clientPortal from '../data/client-portal.js';
import * as clientBusinesses from '../data/client-businesses.js';
import * as sales from '../data/sales.js';
import { makerBundleToClientDataBank } from './maker-bundle-to-bank.js';

function text(value = '') {
  return String(value ?? '').trim();
}

export function findBusinessForMakerPush({
  businessId = '',
  portalUserId = '',
  salesClientId = '',
  email = '',
} = {}) {
  const directBusiness = text(businessId);
  if (directBusiness && clientPortal.getClientProfileByBusinessId(directBusiness)) {
    const profile = clientPortal.getClientProfileByBusinessId(directBusiness);
    return {
      businessId: directBusiness,
      userId: text(profile?.ownerUserId || profile?.userId),
      profile,
    };
  }

  if (salesClientId) {
    const client = sales.getSalesClientById(salesClientId);
    const fromSales = text(client?.portalBusinessId);
    if (fromSales && clientPortal.getClientProfileByBusinessId(fromSales)) {
      const profile = clientPortal.getClientProfileByBusinessId(fromSales);
      return {
        businessId: fromSales,
        userId: text(profile?.ownerUserId || profile?.userId || client?.portalUserId),
        profile,
      };
    }
    if (text(client?.portalUserId)) {
      const profile = clientPortal.getClientProfileByUserId(client.portalUserId);
      if (profile) {
        return {
          businessId: text(profile.businessId || profile.userId),
          userId: text(client.portalUserId),
          profile,
        };
      }
    }
  }

  if (text(portalUserId)) {
    const profile = clientPortal.getClientProfileByUserId(portalUserId);
    if (profile) {
      return {
        businessId: text(profile.businessId || profile.userId),
        userId: text(portalUserId),
        profile,
      };
    }
  }

  const wanted = text(email).toLowerCase();
  if (wanted) {
    const match = clientPortal.listClientProfiles().find((profile) => {
      const profileEmail = text(profile?.email || profile?.clientDataBank?.generalInfo?.companyEmail).toLowerCase();
      return profileEmail && profileEmail === wanted;
    });
    if (match) {
      return {
        businessId: text(match.businessId || match.userId),
        userId: text(match.ownerUserId || match.userId),
        profile: match,
        matchedByEmail: true,
      };
    }
  }

  return null;
}

export function findPortalUserIdForMakerPush(input = {}) {
  return text(findBusinessForMakerPush(input)?.userId);
}

export function applyMakerBundleToPortal({
  portalUserId = '',
  salesClientId = '',
  email = '',
  bundle = {},
  runId = '',
  publicPreviewUrl = '',
  tunnelUrl = '',
  businessId = '',
} = {}) {
  const hit = findBusinessForMakerPush({ businessId, portalUserId, salesClientId, email });
  if (!hit) {
    return { ok: false, status: 404, message: 'Fant ingen kundekonto å synke til (koble portalbruker eller match e-post første gang).' };
  }
  const current = hit.profile?.clientDataBank || {};
  const nextBank = makerBundleToClientDataBank(bundle, current);
  nextBank.makerLink = {
    ...(nextBank.makerLink || {}),
    businessId: hit.businessId,
    salesClientId: text(salesClientId) || text(nextBank.makerLink?.salesClientId),
    runId: text(runId) || text(nextBank.makerLink?.runId),
    publicPreviewUrl: text(publicPreviewUrl) || text(nextBank.makerLink?.publicPreviewUrl),
    tunnelUrl: text(tunnelUrl) || text(nextBank.makerLink?.tunnelUrl),
  };
  const profile = clientPortal.setClientDataBank(hit.userId, nextBank, { businessId: hit.businessId });
  if (salesClientId) {
    try {
      sales.updateSalesClient(salesClientId, {
        portalUserId: hit.userId,
        portalBusinessId: hit.businessId,
        makerBundleId: text(bundle.id),
      });
    } catch {
      // sales patch is best-effort
    }
  }
  if (hit.userId && hit.businessId) {
    clientBusinesses.ensureOwnerMembership({
      userId: hit.userId,
      email: hit.profile?.email || email,
      businessId: hit.businessId,
    });
  }
  return {
    ok: true,
    userId: hit.userId,
    businessId: hit.businessId,
    matchedByEmail: Boolean(hit.matchedByEmail),
    profile,
    clientDataBank: profile?.clientDataBank || nextBank,
    summary: {
      companyName: nextBank.businessCard?.companyName,
      industry: nextBank.businessCard?.industry,
      catalogCount: (nextBank.productCatalogs || []).length,
      productCount: (nextBank.productCatalogs || []).reduce(
        (sum, catalog) => sum + (catalog.categories || []).reduce((inner, category) => inner + (category.products || []).length, 0),
        0
      ),
    },
  };
}
