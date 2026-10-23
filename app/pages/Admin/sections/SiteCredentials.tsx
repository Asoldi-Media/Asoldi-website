import React from 'react';
import type { Site } from '../shared';
import { authHeaders } from '../shared';

/** One row of GET /api/hub/site-credentials (never a hash or credential). */
export type SiteCredentialInfo = {
  siteId: string;
  enrolled: boolean;
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
};

type AuditRow = { at: string; action: string; ok?: boolean; reason?: string; siteId?: string; by?: string; enrollment?: string; origin?: string };

export type SiteCredentialsData = {
  settings: { enrollment: 'on' | 'off'; updatedAt: string; updatedBy: string };
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

  async function revoke(site: Site) {
    if (!window.confirm(`Revoke the server credential of ${site.name || site.domain}? Its CMS must enroll again (automatic on CMS 2.2.2 and later) before payments and the client admin password sync work again.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/hub/sites/${encodeURIComponent(site.id)}/site-credential/revoke`, { method: 'POST', headers: authHeaders() });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) window.alert(json.message || 'Could not revoke the credential.');
      await load();
    } finally {
      setBusy(false);
    }
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

  return { data, error, busy, byId, load, revoke, setEnrollment };
}

/** Per site in Manage clients: enrolled yes/no, when, the domain that gave the proof, and revoke. */
export function SiteCredentialStatus({ site, info, busy, onRevoke }: { site: Site; info?: SiteCredentialInfo; busy?: boolean; onRevoke: (site: Site) => void }) {
  const unverified = site.cms?.unverified;
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
      ) : (
        <p className="text-gray-400">
          <span className="inline-block w-2 h-2 rounded-full mr-2 bg-amber-400" />
          Server credential: not enrolled
          {info?.revokedAt ? ` (revoked ${when(info.revokedAt)}${info.revokedBy ? ` by ${info.revokedBy}` : ''})` : ''}
          {' '}· payments and the client admin password sync need CMS 2.2.2 or later (1.7.2 on 1.7 sites)
        </p>
      )}
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
  const { data, error, busy, setEnrollment } = useSiteCredentials();
  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!data) return <p className="text-sm text-gray-400">Loading site credentials…</p>;
  const on = data.settings.enrollment === 'on';
  return (
    <section className="space-y-2">
      <h3 className="text-white font-medium">Site credentials (client CMS → hub)</h3>
      <p className="text-sm text-gray-300">
        <span className={`inline-block w-2 h-2 rounded-full mr-2 ${on ? 'bg-green-400' : 'bg-amber-400'}`} />
        Enrollment is {on ? 'on' : 'off'}
        {data.settings.updatedAt ? ` (changed ${when(data.settings.updatedAt)}${data.settings.updatedBy ? ` by ${data.settings.updatedBy}` : ''})` : ''}.
        {' '}{data.totals.enrolled} of {data.totals.sites} sites enrolled · {data.totals.reenrollments} re-enrollments · {data.totals.revoked} revoked.
      </p>
      <p className="text-xs text-gray-500">
        When on, a client CMS (2.2.2 or later) proves itself by answering the hub from its stored domain, then sends its credential on payment, admin
        and heartbeat calls. The site key alone is a public identifier. Switching on lets the hub call each client domain once per enrollment.
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
                {row.by ? ` · ${row.by}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
