import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-client-identity-'));
process.env.APP_DATA_DIR = dataDir;

const businesses = await import('../data/client-businesses.js');
const portal = await import('../data/client-portal.js');
const offers = await import('../data/offers.js');
const sales = await import('../data/sales.js');
const sync = await import('../lib/maker-bundle-sync.js');

const owner = { id: 'user-owner', username: 'owner@cafe.no', name: 'Kari' };
const agency = { id: 'user-agency', username: 'dev@byra.no', name: 'Dev' };

test('first signup creates a business id; later links stay on that id after email change', () => {
  const session = portal.presentClientSession(owner);
  assert.ok(session.profile.businessId);
  assert.equal(session.businesses.length, 1);
  const businessId = session.activeBusinessId;

  portal.updateOwnedLoginEmails(owner.id, 'ny@cafe.no');
  const afterEmail = portal.getClientProfileByBusinessId(businessId);
  assert.equal(afterEmail.email, 'ny@cafe.no');

  const hit = sync.findBusinessForMakerPush({
    businessId,
    email: 'owner@cafe.no',
  });
  assert.equal(hit.businessId, businessId);
  assert.equal(hit.matchedByEmail, undefined);
});

test('email is only first-time match; next maker push uses businessId even if email differs', () => {
  const profile = portal.getClientProfileByUserId(owner.id);
  const first = sync.applyMakerBundleToPortal({
    email: profile.email,
    bundle: { id: 'bundle-1', name: 'Cafe', data: { email: profile.email, businessName: 'Kafeen' } },
  });
  assert.equal(first.ok, true);
  assert.ok(first.businessId);
  assert.equal(first.matchedByEmail, true);

  portal.updateOwnedLoginEmails(owner.id, 'third@cafe.no');
  const second = sync.applyMakerBundleToPortal({
    businessId: first.businessId,
    email: 'someone-else@old.no',
    bundle: { id: 'bundle-1', name: 'Cafe', data: { email: 'someone-else@old.no', businessName: 'Kafeen' } },
  });
  assert.equal(second.ok, true);
  assert.equal(second.businessId, first.businessId);
  assert.equal(second.matchedByEmail, false);
});

test('invite existing user, they can switch between own business and client business', () => {
  portal.presentClientSession(agency);
  const cafeId = portal.getClientProfileByUserId(owner.id).businessId;
  const invited = businesses.inviteMember({
    businessId: cafeId,
    email: agency.username,
    role: 'admin',
    invitedBy: owner.id,
    userId: agency.id,
  });
  assert.equal(invited.ok, true);
  assert.equal(invited.membership.status, 'active');

  const agencySession = portal.presentClientSession(agency);
  assert.ok(agencySession.businesses.some((row) => row.id === cafeId));
  assert.ok(agencySession.businesses.length >= 2);

  const switched = portal.switchBusinessForUser(agency.id, cafeId);
  assert.equal(switched.businessId, cafeId);
  assert.equal(portal.requireBusinessAccess(agency.id, cafeId, { manage: true }).ok, true);
});

test('offer delivery email is not the durable key once businessId is stamped', () => {
  const businessId = portal.getClientProfileByUserId(owner.id).businessId;
  const offer = offers.createOffer({
    targetEmail: 'old-inbox@cafe.no',
    targetUserId: owner.id,
    businessId,
    planId: 'tier-1-standard',
  });
  const found = offers.getActiveOfferForUser({
    userId: owner.id,
    email: 'third@cafe.no',
    businessId,
    membershipBusinessIds: [businessId],
  });
  assert.equal(found.id, offer.id);

  const other = offers.createOffer({
    targetEmail: 'third@cafe.no',
    businessId: 'biz_other',
    planId: 'tier-2-standard',
  });
  const stillCafe = offers.getActiveOfferForUser({
    userId: owner.id,
    email: 'third@cafe.no',
    businessId,
    membershipBusinessIds: [businessId],
  });
  assert.equal(stillCafe.id, offer.id);
  assert.notEqual(stillCafe.id, other.id);
});

test('sales client can store portalBusinessId separately from contact email', () => {
  const created = sales.createSalesClient({
    businessName: 'Kafeen',
    contactEmail: 'kontakt@cafe.no',
    ownerId: 'sales-1',
  });
  const businessId = portal.getClientProfileByUserId(owner.id).businessId;
  const updated = sales.updateSalesClient(created.id, {
    portalUserId: owner.id,
    portalBusinessId: businessId,
    clientEmail: 'third@cafe.no',
  });
  assert.equal(updated.portalBusinessId, businessId);
  const hit = sync.findBusinessForMakerPush({
    salesClientId: created.id,
    email: 'kontakt@cafe.no',
  });
  assert.equal(hit.businessId, businessId);
});
