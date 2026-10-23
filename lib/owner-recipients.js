/**
 * Owner recipients for client-site notices (WS7.39 hotfix).
 *
 * Form submissions and CMS order notices ("Ny nettbestilling") reach the hub
 * through /api/client-forms/:siteKey. Hub sites have no contactEmail field, so
 * they all went to Asoldi's inbox. resolveOwnerRecipients finds the confirmed
 * client owner; resolveFormRouting applies it behind the per-site switch
 * `ownerRouting` in email-sites.json:
 *   ''                 → unchanged (Asoldi inbox), the default for existing sites
 *   'owner'            → the owner only
 *   'owner+asoldi-bcc' → the owner, with BCC to Asoldi for 30 days after the switch
 */
import { normalizeOwnerRouting, patchEmailSite, readEmailSite } from '../data/email-store.js';

export const OWNER_ROUTING_MODES = Object.freeze(['', 'owner', 'owner+asoldi-bcc']);
export const NO_OWNER_SUBJECT_PREFIX = '[Ingen eier-e-post satt]';
export const OWNER_BCC_DAYS = 30;
const MAX_OWNER_RECIPIENTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+$/;

function clean(value) {
  return String(value ?? '').trim();
}

export function normalizeOwnerEmail(value) {
  const email = clean(value).toLowerCase();
  return EMAIL_RE.test(email) ? email : '';
}

/** Today's inbox for client forms when the site names no recipient. */
export function fallbackFormInbox(env = process.env) {
  return clean(env.BOOKING_INBOX_EMAIL) || clean(env.SALES_CONTACT_EMAIL) || 'kontakt@asoldi.com';
}

export function asoldiCopyAddress(env = process.env) {
  return clean(env.SALES_CONTACT_EMAIL) || clean(env.BOOKING_INBOX_EMAIL) || 'kontakt@asoldi.com';
}

function readEmailSiteSafe(siteId) {
  try {
    return readEmailSite(siteId);
  } catch {
    return null;
  }
}

/** Linked by hub site key or hub site id only. Domain and name matches are too loose for routing mail. */
export function salesClientLinkedToSite(site, client) {
  if (!site || !client) return false;
  const siteKey = clean(site.site_key);
  const clientKey = clean(client.hubSite?.siteKey);
  if (siteKey && clientKey && siteKey === clientKey) return true;
  const siteId = clean(site.id);
  const clientSiteId = clean(client.hubSite?.id);
  return Boolean(siteId && clientSiteId && siteId === clientSiteId);
}

function linkedSalesClientEmail(site, getSalesClients) {
  let clients = [];
  try {
    clients = typeof getSalesClients === 'function' ? getSalesClients() : getSalesClients;
  } catch {
    clients = [];
  }
  if (!Array.isArray(clients)) return '';
  const linked = clients.filter((client) => salesClientLinkedToSite(site, client));
  const byKey = linked.filter((client) => clean(site.site_key) && clean(client.hubSite?.siteKey) === clean(site.site_key));
  for (const client of [...byKey, ...linked]) {
    const email = normalizeOwnerEmail(client.contactEmail);
    if (email) return email;
  }
  return '';
}

/**
 * Owner recipients, in order:
 * 1. confirmed ownerRecipients in email-sites.json,
 * 2. site.clientAdmin.email (auto-confirmed: Asoldi entered it),
 * 3. contactEmail of the sales client linked by site key or id,
 * 4. none → callers use the fallback inbox with the "[Ingen eier-e-post satt]" prefix.
 */
export function resolveOwnerRecipients(site, { emailSite, getSalesClients } = {}) {
  if (!site) return { recipients: [], source: 'none' };
  const row = emailSite === undefined ? readEmailSiteSafe(site.id) : emailSite;
  const confirmed = (Array.isArray(row?.ownerRecipients) ? row.ownerRecipients : [])
    .filter((entry) => entry && entry.status === 'confirmed')
    .map((entry) => normalizeOwnerEmail(entry.email))
    .filter(Boolean);
  const unique = [...new Set(confirmed)].slice(0, MAX_OWNER_RECIPIENTS);
  if (unique.length) return { recipients: unique, source: 'ownerRecipients' };
  const adminEmail = normalizeOwnerEmail(site.clientAdmin?.email);
  if (adminEmail) return { recipients: [adminEmail], source: 'clientAdmin' };
  const salesEmail = linkedSalesClientEmail(site, getSalesClients);
  if (salesEmail) return { recipients: [salesEmail], source: 'salesClient' };
  return { recipients: [], source: 'none' };
}

export function ownerBccUntil(row) {
  const setAt = Date.parse(clean(row?.ownerRoutingSetAt));
  return Number.isFinite(setAt) ? new Date(setAt + OWNER_BCC_DAYS * DAY_MS).toISOString() : '';
}

/**
 * How a client-form or CMS notice is addressed. `mode: ''` means today's behaviour,
 * and callers must then build the mail exactly as before.
 */
export function resolveFormRouting(site, { emailSite, getSalesClients, env = process.env, now = Date.now() } = {}) {
  const row = emailSite === undefined ? readEmailSiteSafe(site?.id) : emailSite;
  const mode = normalizeOwnerRouting(row?.ownerRouting);
  if (!site || !mode) return { mode: '' };
  const owner = resolveOwnerRecipients(site, { emailSite: row, getSalesClients });
  if (!owner.recipients.length) {
    return {
      mode,
      to: fallbackFormInbox(env),
      subjectPrefix: `${NO_OWNER_SUBJECT_PREFIX} `,
      source: 'fallback',
    };
  }
  const until = ownerBccUntil(row);
  // No timestamp (row edited by hand) → keep the copy: Asoldi sees the first weeks either way.
  const bccActive = mode === 'owner+asoldi-bcc' && (!until || Date.parse(until) > now);
  return {
    mode,
    to: owner.recipients.join(', '),
    // false turns off the transport's default copy; after the window only the owner gets client data.
    bcc: bccActive ? asoldiCopyAddress(env) : false,
    subjectPrefix: '',
    source: owner.source,
    bccUntil: mode === 'owner+asoldi-bcc' ? until : '',
  };
}

export function ownerRoutingView(site, { getSalesClients, env = process.env, now = Date.now() } = {}) {
  const row = readEmailSiteSafe(site.id) || {};
  const owner = resolveOwnerRecipients(site, { emailSite: row, getSalesClients });
  const routing = resolveFormRouting(site, { emailSite: row, getSalesClients, env, now });
  return {
    siteId: site.id,
    ownerRouting: normalizeOwnerRouting(row.ownerRouting),
    ownerRoutingSetAt: clean(row.ownerRoutingSetAt),
    ownerRecipients: (row.ownerRecipients || []).map((entry) => ({ email: entry.email, status: entry.status, source: entry.source, confirmedAt: entry.confirmedAt || '' })),
    owner,
    routing: routing.mode
      ? { to: routing.to, bcc: routing.bcc || '', subjectPrefix: routing.subjectPrefix, bccUntil: routing.bccUntil || '' }
      : { to: fallbackFormInbox(env), bcc: '', subjectPrefix: '', bccUntil: '' },
    modes: OWNER_ROUTING_MODES,
  };
}

/**
 * `ownerEmails` from Superadmin is the confirmed set. An address that is already
 * confirmed keeps its row (status, confirmedAt, source). A new address, or a pending
 * one Superadmin lists explicitly, becomes confirmed by Superadmin. Pending rows that
 * are not listed stay pending (they wait for their own confirmation, plan 3.3.9), so
 * changing only the mode never confirms anyone.
 */
export function mergeSuperadminOwnerEmails(rows, emails, at) {
  const existing = Array.isArray(rows) ? rows.filter((row) => row && row.email) : [];
  const byEmail = new Map(existing.map((row) => [row.email, row]));
  const listed = new Set(emails);
  const next = emails.map((email) => {
    const row = byEmail.get(email);
    if (row && row.status === 'confirmed') return { ...row };
    // Superadmin entries are confirmed, like clientAdmin.email.
    return { email, status: 'confirmed', confirmedAt: at, source: 'superadmin' };
  });
  for (const row of existing) {
    if (row.status !== 'confirmed' && !listed.has(row.email)) next.push({ ...row });
  }
  return next;
}

function actorName(req) {
  return clean(req.admin?.username || req.user?.username || req.salesUser?.accountKey) || 'superadmin';
}

/** Superadmin: read and set the per-site owner routing (and optionally confirmed owner addresses). */
export function registerOwnerRoutingRoutes(app, { adminAuth, getSiteById, getSalesClients, now = () => Date.now() }) {
  app.get('/api/hub/sites/:id/owner-routing', adminAuth, (req, res) => {
    const site = getSiteById(req.params.id);
    if (!site) return res.status(404).json({ message: 'Site not found.' });
    try {
      return res.json(ownerRoutingView(site, { getSalesClients, now: now() }));
    } catch (error) {
      return res.status(503).json({ message: 'E-postinnstillingene kan ikke leses akkurat nå.', code: error?.code || 'unavailable' });
    }
  });

  app.put('/api/hub/sites/:id/owner-routing', adminAuth, async (req, res) => {
    const site = getSiteById(req.params.id);
    if (!site) return res.status(404).json({ message: 'Site not found.' });
    const body = req.body || {};
    const rawMode = clean(body.ownerRouting).toLowerCase();
    if (!OWNER_ROUTING_MODES.includes(rawMode)) {
      return res.status(400).json({ message: 'Ugyldig ruting. Bruk "", "owner" eller "owner+asoldi-bcc".' });
    }
    const patch = {};
    let current;
    try {
      current = readEmailSite(site.id);
    } catch (error) {
      return res.status(503).json({ message: 'E-postinnstillingene kan ikke leses akkurat nå.', code: error?.code || 'unavailable' });
    }
    if (rawMode !== current.ownerRouting) {
      patch.ownerRouting = rawMode;
      // The 30-day BCC window starts at every switch.
      patch.ownerRoutingSetAt = new Date(now()).toISOString();
      patch.ownerRoutingSetBy = actorName(req);
    }
    if (body.ownerEmails !== undefined) {
      const list = Array.isArray(body.ownerEmails) ? body.ownerEmails : String(body.ownerEmails || '').split(/[,;\s]+/);
      const raw = list.map(clean).filter(Boolean);
      const emails = [...new Set(raw.map(normalizeOwnerEmail).filter(Boolean))];
      if (emails.length !== new Set(raw.map((e) => e.toLowerCase())).size) {
        return res.status(400).json({ message: 'En av e-postadressene er ugyldig.' });
      }
      if (emails.length > MAX_OWNER_RECIPIENTS) {
        return res.status(400).json({ message: `Maks ${MAX_OWNER_RECIPIENTS} eier-adresser.` });
      }
      patch.ownerRecipients = mergeSuperadminOwnerEmails(current.ownerRecipients, emails, new Date(now()).toISOString());
    }
    try {
      if (Object.keys(patch).length) await patchEmailSite(site.id, patch);
      return res.json(ownerRoutingView(site, { getSalesClients, now: now() }));
    } catch (error) {
      return res.status(503).json({ message: 'Kunne ikke lagre e-postrutingen.', code: error?.code || 'unavailable' });
    }
  });
}
