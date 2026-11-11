/**
 * Authentication of client CMS → hub calls for the shop routes (server to server).
 *
 * The site key (x-site-key) is a public identifier, so:
 * - calls that move money, change a payee or read payment details need the site credential always
 *   (moneyAuth);
 * - status and documents need it too, except for a shop site that has never enrolled and whose
 *   trusted CMS version is 2.0.0 up to 2.2.1 (those versions call them with the site key alone)
 *   (siteAuth).
 * Both set req.shopSite (lib/site-credentials.js requireSiteCredential). The email routes use the
 * per-site emailKey instead (lib/email-site-auth.js requireEmailKey).
 */
import * as hub from '../data/hub.js';
import { legacyKeyOnlySite, requireSiteCredential } from './site-credentials.js';

export const moneyAuth = requireSiteCredential({ getSiteByKey: (key) => hub.getSiteByKey(key), policy: 'always' });

export const siteAuth = requireSiteCredential({
  getSiteByKey: (key) => hub.getSiteByKey(key),
  policy: 'when-enrolled',
  legacyAllowed: (site) => legacyKeyOnlySite(site, { shop: true }),
});
