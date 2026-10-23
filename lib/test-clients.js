// Test clients and test sites (WS8.56).
//
// `client.isTest` / `site.isTest` are set from Superadmin. A test client (for example the canary
// client the delivery chain is tried on) stays visible and workable on the boards, but it never
// counts anywhere numbers are reported or shown to prospects:
// - social proof (WS8.39), nurture (WS8.38), rankings, sales reports and analytics totals;
// - Myphoner sync, both directions: no lead is copied out for it and no Myphoner event patches it;
// - the gate F1 evaluation set (WS8.52).
// It takes part in delivery automation only when listed in automation pilotClientIds
// (see automationScopeForClient in data/automation-settings.js).
// Pure module: callers pass the records.

export function isTestClient(client) {
  return client?.isTest === true;
}

export function isTestSite(site) {
  return site?.isTest === true;
}

/** Clients that may be counted in reports, rankings, social proof and evaluation sets. */
export function reportableClients(clients) {
  return (Array.isArray(clients) ? clients : []).filter((client) => !isTestClient(client));
}

/** Sites that may be counted in reports, analytics totals and social proof. */
export function reportableSites(sites) {
  return (Array.isArray(sites) ? sites : []).filter((site) => !isTestSite(site));
}

export function testClientIdSet(clients) {
  return new Set(
    (Array.isArray(clients) ? clients : [])
      .filter(isTestClient)
      .map((client) => String(client.id || ''))
      .filter(Boolean),
  );
}

/** Myphoner lead ids that belong to test clients; nothing is ever pushed to Myphoner for them. */
export function testClientMyphonerLeadIds(clients) {
  const ids = new Set();
  for (const client of Array.isArray(clients) ? clients : []) {
    if (!isTestClient(client)) continue;
    const main = String(client.myphoner?.leadId || '').trim();
    if (main) ids.add(main);
    for (const extra of Array.isArray(client.myphoner?.leadIds) ? client.myphoner.leadIds : []) {
      const value = String(extra || '').trim();
      if (value) ids.add(value);
    }
  }
  return ids;
}

/** Why a Myphoner sync must leave this client alone ('' when it may proceed). */
export function myphonerSyncSkipReason(client) {
  return isTestClient(client) ? 'test-client' : '';
}

/** Records whose `salesClientId` points at a test client are left out (offers, change requests, ...). */
export function withoutTestClientRecords(records, clients, key = 'salesClientId') {
  const ids = testClientIdSet(clients);
  return (Array.isArray(records) ? records : []).filter((record) => !ids.has(String(record?.[key] || '')));
}
