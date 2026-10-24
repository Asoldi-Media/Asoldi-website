import React from 'react';
import type { Site } from '../shared';
import { authHeaders } from '../shared';

/** One row of GET /api/hub/site-credentials (never a hash or credential). */
export type SiteCredentialInfo = {
  siteId: string;
  enrolled: boolean;
  /** The site had a credential that was revoked: closed until it enrolls again. */
  revoked: boolean;
  enrolledAt: string;
  firstEnrolledAt: string;
  proofDomain: string;
  proofOrigin: string;
  enrollCount: number;
  reenrollCount: number;
  revokedAt: string;
  revokedBy: string;
  domain: string;
  proofDomainMatches: boolean;
  /** The site key alone still opens the dashboard (analytics) and shop status and documents (shop). */
  legacyKeyOnly: { analytics: boolean; shop: boolean };
  /** A 2.0.0–2.2.1 version from the last unverified heartbeat (a CMS that went back), else ''. */
  reportedLegacyVersion: string;
};

type AuditRow = { at: string; action: string; ok?: boolean; reason?: string; siteId?: string; by?: string; enrollment?: string; origin?: string; trustedVersion?: string };

export type SiteCredentialsData = {
  settings: { enrollment: 'on' | 'off'; updatedAt: string; updatedBy: string };
  store: { ok: boolean; problem?: string };
  sites: SiteCredentialInfo[];
  totals: { sites: number; enrolled: number; reenrollments: number; revoked: number };
  recent: AuditRow[];
};

function when(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('nb-NO');
}

/** Loads the site credential list once (and again after a change). */
export function useSiteCredentials(sites: Site[] = []) {
  const [data, setData] = React.useState<SiteCredentialsData | null>(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const siteCount = sites.length;

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/hub/site-credentials', { headers: authHeaders() });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.message || 'Could not load site credentials');
        return;
      }
      setError('');
      setData(json as SiteCredentialsData);
    } catch {
      setError('Could not load site credentials');
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load, siteCount]);

  const byId = React.useMemo(() => new Map((data?.sites || []).map((row) => [row.siteId, row])), [data]);

  async function post(path: string, failure: string) {
    setBusy(true);
    try {
      const res = await fetch(path, { method: 'POST', headers: authHeaders() });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) window.alert(json.message || failure);
      await load();
      return res.ok ? json : null;
    } finally {
      setBusy(false);
    }
  }

  async function revoke(site: Site) {
    if (!window.confirm(`Revoke the server credential of ${site.name || site.domain}? Its CMS must enroll again (automatic on CMS 2.2.2 and 1.7.2) before payments, shop documents and the client admin password sync work again.`)) return;
    await post(`/api/hub/sites/${encodeURIComponent(site.id)}/site-credential/revoke`, 'Could not revoke the credential.');
  }

  async function reset(site: Site) {
    const info = byId.get(String(site.id));
    const version = info?.reportedLegacyVersion;
    const message = version
      ? `Reset the credential record of ${site.name || site.domain}? Use this only when the site went back to CMS ${version}. The hub then treats it as a site that never enrolled and takes ${version} as its version, so shop status, documents and the dashboard work with the site key again. Payments still need a credential.`
      : `Reset the credential record of ${site.name || site.domain}? The hub then treats it as a site that never enrolled. Payments, shop documents and the client admin password still need a credential.`;
    if (!window.confirm(message)) return;
    await post(`/api/hub/sites/${encodeURIComponent(site.id)}/site-credential/reset`, 'Could not reset the credential record.');
  }

  async function setAsideUnreadable() {
    if (!window.confirm('Set the unreadable credential store aside and start an empty one? Every enrolled site then enrolls again on its own (CMS 2.2.2 and 1.7.2).')) return;
    await post('/api/hub/site-credentials/set-aside-unreadable', 'Could not set the store aside.');
  }

  async function setEnrollment(enrollment: 'on' | 'off') {
    setBusy(true);
    try {
      const res = await fetch('/api/hub/site-credentials/settings', {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ enrollment }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) setError(json.message || 'Could not save.');
      await load();
    } finally {
      setBusy(false);
    }
  }

  return { data, error, busy, byId, load, revoke, reset, setAsideUnreadable, setEnrollment };
}

/** Per site in Manage clients: enrolled yes/no, when, the domain that gave the proof, revoke and reset. */
export function SiteCredentialStatus({
  site,
  info,
  busy,
  onRevoke,
  onReset,
}: {
  site: Site;
  info?: SiteCredentialInfo;
  busy?: boolean;
  onRevoke: (site: Site) => void;
  onReset: (site: Site) => void;
}) {
  const unverified = site.cms?.unverified;
  const legacy = info?.legacyKeyOnly;
  return (
    <div className="text-xs space-y-0.5">
      {info?.enrolled ? (
        <p className="text-gray-300">
          <span className="inline-block w-2 h-2 rounded-full mr-2 bg-green-400" />
          Server credential: enrolled {when(info.enrolledAt)}
          {info.proofDomain ? ` · proof from ${info.proofDomain}` : ''}
          {info.reenrollCount ? ` · re-enrolled ${info.reenrollCount}×` : ''}
          <button type="button" disabled={busy} onClick={() => onRevoke(site)} className="ml-2 text-red-300 hover:underline disabled:opacity-50">
            Revoke
          </button>
        </p>
      ) : info?.revoked ? (
        <p className="text-gray-400">
          <span className="inline-block w-2 h-2 rounded-full mr-2 bg-red-400" />
          Server credential: revoked {when(info.revokedAt)}
          {info.revokedBy ? ` by ${info.revokedBy}` : ''} · closed until the site enrolls again (automatic on CMS 2.2.2 and 1.7.2)
        </p>
      ) : (
        <p className="text-gray-400">
          <span className="inline-block w-2 h-2 rounded-full mr-2 bg-amber-400" />
          Server credential: not enrolled · payments and the client admin password sync need CMS 2.2.2 or later (1.7.2 on 1.7 sites)
          {legacy?.shop || legacy?.analytics
            ? ` · site key still accepted for ${[legacy.shop ? 'shop status and documents' : '', legacy.analytics ? 'the dashboard and shop summary' : ''].filter(Boolean).join(' and ')} (CMS ${site.cms?.packageVersion || ''})`
            : ''}
        </p>
      )}
      {info?.enrolled || info?.revoked ? (
        <p className="text-gray-500">
          {info.reportedLegacyVersion ? `The last unverified heartbeat reports CMS ${info.reportedLegacyVersion}, which has no credential. ` : ''}
          <button type="button" disabled={busy} onClick={() => onReset(site)} className="text-amber-300 hover:underline disabled:opacity-50">
            Reset for an older CMS
          </button>
        </p>
      ) : null}
      {info?.enrolled && !info.proofDomainMatches ? (
        <p className="text-amber-300">The stored domain changed after the last proof ({info.proofDomain}). Revoke to make the site prove the new domain.</p>
      ) : null}
      {unverified?.packageVersion || unverified?.adminUrl ? (
        <p className="text-gray-500">
          Last unverified heartbeat {when(unverified.at)} reported{unverified.packageVersion ? ` CMS ${unverified.packageVersion}` : ''}
          {unverified.adminUrl ? ` at ${unverified.adminUrl}` : ''} (shown only, not used)
        </p>
      ) : null}
    </div>
  );
}

/** Security card: the enrollment switch, totals and the latest enrollment events. */
export function SiteCredentialsPanel() {
  const { data, error, busy, setEnrollment, setAsideUnreadable } = useSiteCredentials();
  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!data) return <p className="text-sm text-gray-400">Loading site credentials…</p>;
  const on = data.settings.enrollment === 'on';
  return (
    <section className="space-y-2">
      <h3 className="text-white font-medium">Site credentials (client CMS → hub)</h3>
      {data.store && !data.store.ok ? (
        <div className="text-sm text-red-300 space-y-1">
          <p>
            The credential store cannot be read. Every credential check fails closed: payments, shop documents and the client admin password sync are
            refused until it is fixed.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void setAsideUnreadable()}
            className="px-3 py-1.5 rounded-lg text-sm border border-red-300/40 text-red-200 hover:bg-white/10 disabled:opacity-50"
          >
            Set it aside and start empty
          </button>
        </div>
      ) : null}
      <p className="text-sm text-gray-300">
        <span className={`inline-block w-2 h-2 rounded-full mr-2 ${on ? 'bg-green-400' : 'bg-amber-400'}`} />
        Enrollment is {on ? 'on' : 'off'}
        {data.settings.updatedAt ? ` (changed ${when(data.settings.updatedAt)}${data.settings.updatedBy ? ` by ${data.settings.updatedBy}` : ''})` : ''}.
        {' '}{data.totals.enrolled} of {data.totals.sites} sites enrolled · {data.totals.reenrollments} re-enrollments · {data.totals.revoked} revoked.
      </p>
      <p className="text-xs text-gray-500">
        When on, a client CMS (2.2.2 or later, 1.7.2 on 1.7 sites) proves itself by answering the hub from its stored domain, then sends its credential on
        payment, admin and heartbeat calls. The site key alone is a public identifier. Switching on lets the hub call each client domain once per
        enrollment. Switch it on together with the first rollout of CMS 2.2.2 or 1.7.2.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void setEnrollment(on ? 'off' : 'on')}
        className="px-3 py-1.5 rounded-lg text-sm border border-white/20 text-gray-200 hover:bg-white/10 disabled:opacity-50"
      >
        {on ? 'Switch enrollment off' : 'Switch enrollment on'}
      </button>
      {data.recent.length > 0 && (
        <details className="text-xs text-gray-400">
          <summary className="cursor-pointer">Latest enrollment events ({data.recent.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {data.recent.map((row, index) => (
              <li key={`${row.at}-${index}`}>
                {when(row.at)} · {row.action}
                {row.siteId ? ` · site ${row.siteId}` : ''}
                {row.ok === false ? ` · refused (${row.reason || 'unknown'})` : row.ok ? ' · ok' : ''}
                {row.enrollment ? ` · ${row.enrollment}` : ''}
                {row.trustedVersion ? ` · version ${row.trustedVersion}` : ''}
                {row.by ? ` · ${row.by}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
