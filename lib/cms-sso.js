/**
 * "Open CMS as Asoldi": a one-time admin login link into a client CMS.
 * The token is signed with that site's site_key (the client server already
 * holds it), lives 60 seconds, and the CMS burns its nonce on first use.
 */
import { createHmac, randomBytes } from 'crypto';

export const CMS_SSO_TTL_MS = 60_000;

function clean(value) {
  return String(value ?? '').trim();
}

/** Origin of the client CMS: the heartbeat admin URL wins over the stored domain. */
export function cmsOrigin(site) {
  for (const raw of [site?.cms?.adminUrl, site?.domain]) {
    const value = clean(raw);
    if (!value) continue;
    try {
      const url = new URL(value.includes('://') ? value : `https://${value}`);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
    } catch {
      /* try the next one */
    }
  }
  return '';
}

export function mintCmsSsoToken(site, { by = 'asoldi', now = Date.now() } = {}) {
  const data = JSON.stringify({ sid: String(site.id), n: randomBytes(16).toString('hex'), exp: now + CMS_SSO_TTL_MS, by: clean(by).slice(0, 80) || 'asoldi' });
  const sig = createHmac('sha256', String(site.site_key)).update(data).digest('hex');
  return Buffer.from(JSON.stringify({ data, sig })).toString('base64url');
}

export function registerCmsSsoRoutes(app, { adminAuth, getSiteById }) {
  app.post('/api/hub/sites/:id/cms-sso', adminAuth, (req, res) => {
    const site = getSiteById(clean(req.params.id));
    if (!site?.site_key) return res.status(404).json({ message: 'Site not found.' });
    const origin = cmsOrigin(site);
    if (!origin) return res.status(409).json({ message: 'This site has no CMS address yet (no domain or heartbeat).' });
    const token = mintCmsSsoToken(site, { by: req.admin?.username || req.admin?.email || 'asoldi' });
    res.set('Cache-Control', 'no-store');
    res.json({ url: `${origin}/api/cms/admin/sso?token=${token}`, expiresInSeconds: CMS_SSO_TTL_MS / 1000 });
  });
}
