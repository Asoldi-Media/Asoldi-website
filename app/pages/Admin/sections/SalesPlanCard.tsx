import React from 'react';
import { API, salesAuthHeaders } from '../shared';

type PlanHistoryEntry = {
  at: string;
  by: string;
  from: { tierId: string } | null;
  to: { tierId: string } | null;
  reason: string;
};

type PlanConflict = { source: string; tierId: string; at: string; status: string };

type SitePlanView = {
  mode: 'off' | 'shadow' | 'auto';
  plan: {
    status: string;
    tierId: string;
    tierName: string;
    services: string[];
    billing: string;
    source: string;
    signedAt: string;
    derived: boolean;
    needsConfirmation: boolean;
    confirmedAt: string;
    confirmedBy: string;
  } | null;
  inForce: boolean;
  history: PlanHistoryEntry[];
  conflicts: PlanConflict[];
  shadow: { at: string; source: string; tierId: string; services: string[]; wouldCreateSite: boolean; needsChoice: boolean } | null;
  canConfirm: boolean;
};

const SOURCE_LABELS: Record<string, string> = {
  'portal-accept': 'akseptert i portalen',
  'preview-accept': 'akseptert på forhåndsvisningen',
  progression: 'kontrakt huket av',
  'inbox-contract': 'signert kontrakt på e-post',
  'got-client': 'flyttet til utvikling',
  'stripe-checkout': 'kortbetaling for tilbudet',
  'offer-upgrade': 'nytt tilbud akseptert',
  superadmin: 'valgt av Superadmin',
  backfill: 'hentet fra eksisterende data',
};

function shortDate(value: string) {
  const ms = Date.parse(value || '');
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleDateString('nb-NO', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * The client's site plan on the sales card: summary, services, history, open conflicts and
 * 'Bekreft tjenester'. Renders nothing while the signing switch is off (the route answers 404).
 */
export function SalesPlanCard({ clientId }: { clientId: string }) {
  const [view, setView] = React.useState<SitePlanView | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    let alive = true;
    setView(null);
    setError('');
    if (!clientId) return undefined;
    fetch(`${API}/admin/sales/${encodeURIComponent(clientId)}/site-plan`, { headers: { ...salesAuthHeaders() } })
      .then(async (res) => (res.ok ? ((await res.json()) as SitePlanView) : null))
      .then((next) => {
        if (alive) setView(next);
      })
      .catch(() => {
        if (alive) setView(null);
      });
    return () => {
      alive = false;
    };
  }, [clientId]);

  if (!view || view.mode === 'off') return null;

  async function confirmServices() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${API}/admin/sales/${encodeURIComponent(clientId)}/site-plan/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...salesAuthHeaders() },
        body: '{}',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.message || 'Kunne ikke bekrefte.');
        return;
      }
      setView(json as SitePlanView);
    } catch {
      setError('Kunne ikke bekrefte.');
    } finally {
      setBusy(false);
    }
  }

  const { plan, shadow } = view;
  return (
    <div className="md:col-span-2 rounded-lg border border-white/10 bg-[#161616] p-3 space-y-2 text-sm text-gray-200">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Plan</span>
        {view.mode === 'shadow' ? <span className="rounded bg-white/10 px-2 py-0.5 text-xs text-gray-300">Skygge</span> : null}
        {plan ? (
          <span>
            {plan.tierName}
            {plan.source ? ` · ${SOURCE_LABELS[plan.source] || plan.source}` : ''}
            {plan.signedAt ? ` ${shortDate(plan.signedAt)}` : ''}
            {plan.status !== 'active' ? ` · ${plan.status === 'void' ? 'opphevet' : 'avsluttet'}` : ''}
          </span>
        ) : (
          <span className="text-gray-400">Ingen plan lagret</span>
        )}
      </div>
      {plan && plan.services.length ? (
        <div className="flex flex-wrap gap-1">
          {plan.services.map((service) => (
            <span key={service} className="rounded bg-white/10 px-2 py-0.5 text-xs">{service}</span>
          ))}
        </div>
      ) : null}
      {view.conflicts.length ? (
        <div className="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-amber-200">
          {view.conflicts.map((conflict) => (
            <div key={`${conflict.source}-${conflict.tierId}-${conflict.at}`}>
              Avvik: {conflict.source} sier {conflict.tierId}{conflict.at ? ` (${shortDate(conflict.at)})` : ''}. Kontrakten gjelder til planen endres.
            </div>
          ))}
        </div>
      ) : null}
      {shadow && view.mode === 'shadow' ? (
        <div className="text-xs text-gray-400">
          Signeringen ville lagret {shadow.tierId || 'ingen plan'}
          {shadow.needsChoice ? ' (tilbudet har to alternativer uten valg)' : ''}
          {shadow.wouldCreateSite ? ' og opprettet nettstedet i hubben' : ''}
          {shadow.at ? ` · ${shortDate(shadow.at)}` : ''}.
        </div>
      ) : null}
      {plan && plan.confirmedAt ? (
        <div className="text-xs text-gray-400">Tjenestene bekreftet {shortDate(plan.confirmedAt)}{plan.confirmedBy ? ` av ${plan.confirmedBy}` : ''}.</div>
      ) : null}
      {view.canConfirm ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void confirmServices()}
          className="px-3 py-1.5 rounded-lg bg-white/10 text-gray-100 text-xs hover:bg-white/15 disabled:opacity-50"
        >
          Bekreft tjenester
        </button>
      ) : null}
      {error ? <div className="text-xs text-red-400">{error}</div> : null}
      {view.history.length ? (
        <details className="text-xs text-gray-400">
          <summary className="cursor-pointer">Historikk</summary>
          <ul className="mt-1 space-y-0.5">
            {view.history.map((entry, index) => (
              <li key={`${entry.at}-${index}`}>
                {shortDate(entry.at)} · {entry.from?.tierId || 'ingen'} → {entry.to?.tierId || '?'} · {SOURCE_LABELS[entry.reason] || entry.reason}
                {entry.by ? ` · ${entry.by}` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
