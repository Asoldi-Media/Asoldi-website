import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { API, authHeaders } from '../shared';

type HitTop = { key: string; route: string; count: number };
type Hits = { total: number; days: { date: string; count: number }[]; top: HitTop[] };
type Wake = { at: string; ok: boolean; status?: number; error?: string; skipped?: string; ms?: number } | null;
type Proposal = { status: 'open' | 'dismissed' | 'applied'; since: string; at?: string; by?: string; auto?: boolean } | null;
type FleetRow = {
  siteId: string;
  name: string;
  domain: string;
  enforcement: 'off' | 'log' | 'on';
  packageVersion: string;
  lastContactAt: string | null;
  contactAgeHours: number | null;
  stale: boolean;
  hits: Hits;
  conflicts: string[];
  failedMigrations: string[];
  wake: Wake;
  unreachable: boolean;
  proposal: Proposal;
  proposable: boolean;
  reasons: string[];
};
type Flip = { siteId: string; at: string; by: string; from: string; to: string; auto: boolean };
type FleetResponse = {
  settings: { monitor: 'off' | 'shadow' | 'auto' | 'paused'; autoApplyFlip: boolean; wakePing: 'off' | 'on' | 'paused'; to: string };
  safeMode: boolean;
  day: string;
  rows: FleetRow[];
  proposals: string[];
  lastReview: { day: string; at: string } | null;
  lastDigest: { day: string; at: string; mailed: boolean; empty: boolean; error?: string } | null;
  flips: Flip[];
};

const card = 'rounded-xl border border-white/10 bg-[#141414] p-4';
const button = 'px-3 py-1.5 rounded-lg text-sm disabled:opacity-50';

const REASONS: Record<string, string> = {
  'not-log': 'ikke i logg',
  'no-report': 'ingen rapport siste døgn',
  'no-tree': 'rapporterer ikke funksjonstreet',
  'not-served': 'treet sendes ikke til siden',
  'block-hits': 'treff siste 7 dager',
  'too-new': 'fulgt i under 7 dager',
};

const MONITOR: Record<FleetResponse['settings']['monitor'], string> = {
  off: 'av',
  shadow: 'skygge (lagres, sendes ikke)',
  auto: 'på (sammendrag sendes)',
  paused: 'pauset',
};

function when(iso: string | null | undefined) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('nb-NO', { dateStyle: 'short', timeStyle: 'short' });
}

function age(hours: number | null) {
  if (hours === null || hours === undefined) return 'aldri';
  if (hours < 1) return 'under 1 t';
  if (hours < 48) return `${Math.round(hours)} t`;
  return `${Math.round(hours / 24)} d`;
}

function reachability(row: FleetRow) {
  const wake = row.wake;
  if (!wake) return <span className="text-gray-500">ikke sjekket</span>;
  if (wake.skipped) return <span className="text-gray-500">hoppet over ({wake.skipped})</span>;
  if (wake.ok) return <span className="text-green-400">ok</span>;
  return <span className="text-red-400">ikke nåbar ({wake.status ? `HTTP ${wake.status}` : wake.error || 'feil'})</span>;
}

function topHits(hits: Hits, limit = 3) {
  return hits.top.slice(0, limit).map((entry) => `${entry.key} ${entry.route} ×${entry.count}`).join('; ');
}

/**
 * Superadmin → System safety → CMS-utrulling. The CMS fleet monitor (lib/cms-fleet-monitor.js):
 * sites proposed for feature enforcement, would-block hits, sites with enforcement on, and one row per
 * CMS site (version, last contact, conflicts, hits, failed migrations, reachability).
 */
export function CmsRolloutCard() {
  const [data, setData] = useState<FleetResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/admin/cms-fleet`, { headers: authHeaders() });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message || 'Kunne ikke hente CMS-flåten.');
        return;
      }
      setData(body);
    } catch {
      setError('Kunne ikke hente CMS-flåten.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(path: string, payload: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${API}/admin/cms-fleet/${path}`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setError(body.message || 'Handlingen feilet.');
      else if (Array.isArray(body.results)) {
        const failed = body.results.filter((row: { ok: boolean }) => !row.ok);
        if (failed.length) setError(`Ikke endret: ${failed.map((row: { siteId: string; error?: string }) => `${row.siteId} (${row.error || 'feil'})`).join(', ')}`);
      }
      await load();
    } catch {
      setError('Handlingen feilet.');
    } finally {
      setBusy(false);
    }
  }

  const rows = data?.rows || [];
  const byId = new Map<string, FleetRow>(rows.map((row): [string, FleetRow] => [row.siteId, row]));
  const proposals = (data?.proposals || []).map((id) => byId.get(id)).filter((row): row is FleetRow => Boolean(row));
  const withHits = rows.filter((row) => row.hits.total > 0);
  const enforced = rows.filter((row) => row.enforcement === 'on');

  function flipAll() {
    if (!proposals.length) return;
    if (!window.confirm(`Slå på håndheving for ${proposals.length} side(r)? CMS-en avviser da funksjoner kunden ikke har.`)) return;
    void post('flip', { all: true });
  }

  return (
    <div className={card}>
      <div className="flex items-center justify-between gap-4 mb-3">
        <h3 className="text-white font-medium inline-flex items-center gap-2">
          <ShieldCheck size={16} /> CMS-utrulling
        </h3>
        <button type="button" onClick={() => void load()} className={`${button} bg-white/10 text-white hover:bg-white/15 inline-flex items-center gap-2`}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Oppdater
        </button>
      </div>
      {error && <p className="text-sm text-red-400 mb-2">{error}</p>}
      {data && (
        <div className="space-y-4 text-sm">
          <p className="text-gray-400">
            Overvåking: <span className="text-white">{MONITOR[data.settings.monitor]}</span>
            {' · '}Helsesjekk: <span className="text-white">{data.settings.wakePing === 'on' ? 'på' : data.settings.wakePing === 'paused' ? 'pauset' : 'av'}</span>
            {' · '}Automatisk håndheving: <span className="text-white">{data.settings.autoApplyFlip ? 'på' : 'av'}</span>
            {data.safeMode ? ' · safe mode: bare rapport' : ''}
            <br />
            Siste gjennomgang: {data.lastReview ? when(data.lastReview.at) : '—'}
            {data.lastDigest ? ` · siste sammendrag ${data.lastDigest.day}${data.lastDigest.empty ? ' (ingenting å melde)' : data.lastDigest.mailed ? ' (sendt)' : ' (lagret)'}${data.lastDigest.error ? `, feil: ${data.lastDigest.error}` : ''}` : ''}
          </p>

          <div>
            <div className="flex items-center justify-between gap-4 mb-1">
              <h4 className="text-white">Forslag: slå på håndheving</h4>
              <button type="button" disabled={busy || !proposals.length} onClick={flipAll} className={`${button} bg-green-600/80 text-white hover:bg-green-600`}>
                Slå på for alle
              </button>
            </div>
            {!proposals.length && <p className="text-gray-500">Ingen forslag nå.</p>}
            <ul className="space-y-1">
              {proposals.map((row) => (
                <li key={row.siteId} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-gray-300">
                    {row.name} <span className="text-gray-500">{row.domain}</span>
                  </span>
                  <span className="inline-flex gap-2">
                    <button type="button" disabled={busy} onClick={() => void post('flip', { siteIds: [row.siteId] })} className={`${button} bg-white/10 text-white hover:bg-white/15`}>
                      Slå på håndheving
                    </button>
                    <button type="button" disabled={busy} onClick={() => void post('dismiss', { siteId: row.siteId })} className={`${button} bg-white/5 text-gray-300 hover:bg-white/10`}>
                      Avvis
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {!!withHits.length && (
            <div>
              <h4 className="text-white mb-1">Treff som ville blitt sperret (7 dager)</h4>
              <ul className="space-y-1">
                {withHits.map((row) => (
                  <li key={row.siteId} className="text-gray-300">
                    {row.name}: {row.hits.total} treff <span className="text-gray-500">{topHits(row.hits)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!!enforced.length && (
            <div>
              <h4 className="text-white mb-1">Håndheving på</h4>
              <ul className="space-y-1">
                {enforced.map((row) => (
                  <li key={row.siteId} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-gray-300">
                      {row.name} <span className="text-gray-500">{row.domain}</span>
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Sett ${row.name} tilbake til logg? Siden må da gå 7 nye dager uten treff før den foreslås igjen.`)) void post('revert', { siteId: row.siteId });
                      }}
                      className={`${button} bg-white/5 text-gray-300 hover:bg-white/10`}
                    >
                      Tilbake til logg
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-gray-500">
                <tr>
                  <th className="py-1 pr-2">Side</th>
                  <th className="py-1 pr-2">Modus</th>
                  <th className="py-1 pr-2">CMS</th>
                  <th className="py-1 pr-2">Sist kontakt</th>
                  <th className="py-1 pr-2">Konflikter</th>
                  <th className="py-1 pr-2">Treff (7 d)</th>
                  <th className="py-1 pr-2">Migreringer</th>
                  <th className="py-1 pr-2">Nåbar</th>
                  <th className="py-1 pr-2">Ikke foreslått fordi</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.siteId} className="border-t border-white/5">
                    <td className="py-1 pr-2 text-gray-300">{row.name}</td>
                    <td className="py-1 pr-2 text-gray-300">{row.enforcement}</td>
                    <td className="py-1 pr-2 text-gray-300">{row.packageVersion || '—'}</td>
                    <td className={`py-1 pr-2 ${row.stale ? 'text-amber-400' : 'text-gray-300'}`}>{age(row.contactAgeHours)}</td>
                    <td className={`py-1 pr-2 ${row.conflicts.length ? 'text-amber-400' : 'text-gray-300'}`}>{row.conflicts.length ? row.conflicts.join(', ') : '0'}</td>
                    <td className="py-1 pr-2 text-gray-300">{row.hits.total}</td>
                    <td className={`py-1 pr-2 ${row.failedMigrations.length ? 'text-red-400' : 'text-gray-300'}`}>{row.failedMigrations.length ? row.failedMigrations.join(', ') : 'ok'}</td>
                    <td className="py-1 pr-2">{reachability(row)}</td>
                    <td className="py-1 pr-2 text-gray-500">{row.proposable ? 'foreslått' : row.reasons.map((reason) => REASONS[reason] || reason).join(', ')}</td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={9} className="py-2 text-gray-500">Ingen CMS-sider har rapportert ennå.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {!!data.flips.length && (
            <div>
              <h4 className="text-white mb-1">Siste endringer</h4>
              <ul className="space-y-0.5 text-xs text-gray-400">
                {data.flips.slice(0, 10).map((flip) => (
                  <li key={`${flip.siteId}-${flip.at}-${flip.to}`}>
                    {when(flip.at)} · {byId.get(flip.siteId)?.name || flip.siteId}: {flip.from} → {flip.to} ({flip.auto ? 'automatisk' : flip.by})
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
