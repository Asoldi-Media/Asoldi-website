import React from 'react';
import { API, salesAuthHeaders } from '../shared';

type PlanHistoryEntry = {
  at: string;
  by: string;
  from: { tierId: string } | null;
  to: { tierId: string } | null;
  reason: string;
};

type PlanConflict = { source: string; tierId: string; at: string; status: string; index?: number; tierName?: string };

type LifecycleView = {
  planChange: string;
  cancellation: string;
  canUnsign: boolean;
  canChangePlan: boolean;
  history: PlanHistoryEntry[];
  conflicts: PlanConflict[];
};

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
  choice?: {
    offerId: string;
    contractReceived: boolean;
    alternatives: Array<{ index: number; tierId: string; tierName: string; billing: string; priceExMva: number }>;
  } | null;
  siteConflicts?: Array<{ siteId: string; at: string }>;
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

function priceLabel(alternative: { billing: string; priceExMva: number }) {
  if (!alternative.priceExMva) return '';
  const amount = alternative.priceExMva.toLocaleString('nb-NO');
  return alternative.billing === 'once' ? ` · ${amount} kr` : ` · ${amount} kr/mnd`;
}

/**
 * The client's site plan on the sales card: summary, services, history, open conflicts and
 * 'Bekreft tjenester'. For an offer with two alternatives and none chosen it lets the rep mark the
 * contract signed with the alternative the client chose. Renders nothing while the signing switch is
 * off (the route answers 404).
 */
export function SalesPlanCard<C = unknown>({ clientId, onClientSaved }: { clientId: string; onClientSaved?: (client: C) => void }) {
  const [view, setView] = React.useState<SitePlanView | null>(null);
  const [lifecycle, setLifecycle] = React.useState<LifecycleView | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [reload, setReload] = React.useState(0);

  React.useEffect(() => {
    let alive = true;
    if (!reload) {
      setView(null);
      setLifecycle(null);
    }
    setError('');
    if (!clientId) return undefined;
    const headers = { ...salesAuthHeaders() };
    fetch(`${API}/admin/sales/${encodeURIComponent(clientId)}/site-plan`, { headers })
      .then(async (res) => (res.ok ? ((await res.json()) as SitePlanView) : null))
      .then((next) => {
        if (alive) setView(next);
      })
      .catch(() => {
        if (alive) setView(null);
      });
    fetch(`${API}/admin/sales/${encodeURIComponent(clientId)}/plan-lifecycle`, { headers })
      .then(async (res) => (res.ok ? ((await res.json()) as LifecycleView) : null))
      .then((next) => {
        if (alive) setLifecycle(next);
      })
      .catch(() => {
        if (alive) setLifecycle(null);
      });
    return () => {
      alive = false;
    };
  }, [clientId, reload]);

  const planChangeOn = Boolean(lifecycle && lifecycle.planChange !== 'off');
  const cancellationOn = Boolean(lifecycle && lifecycle.cancellation !== 'off');

  async function signWithAlternative(index: number, label: string) {
    if (!window.confirm(`Marker kontrakten som signert med ${label}?`)) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${API}/admin/sales/${encodeURIComponent(clientId)}/progression`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...salesAuthHeaders() },
        body: JSON.stringify({ key: 'contractSigned', value: true, fastTrack: true, chosenOfferIndex: index }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.message || 'Kunne ikke signere.');
        return;
      }
      if (json.client && onClientSaved) onClientSaved(json.client as C);
      setReload((value) => value + 1);
    } catch {
      setError('Kunne ikke signere.');
    } finally {
      setBusy(false);
    }
  }

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

  async function resolveConflict(index: number, action: 'accept' | 'dismiss') {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${API}/admin/sales/${encodeURIComponent(clientId)}/site-plan/conflicts/${index}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...salesAuthHeaders() },
        body: '{}',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.message || 'Kunne ikke oppdatere avviket.');
        return;
      }
      setReload((value) => value + 1);
    } catch {
      setError('Kunne ikke oppdatere avviket.');
    } finally {
      setBusy(false);
    }
  }

  async function unsign() {
    if (!window.confirm('Oppheve signeringen? Planen settes til side. Et nettsted som ikke er publisert arkiveres, det slettes ikke.')) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${API}/admin/sales/${encodeURIComponent(clientId)}/unsign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...salesAuthHeaders() },
        body: JSON.stringify({ reason: 'Opphevet fra salgskortet' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.message || 'Kunne ikke oppheve signeringen.');
        return;
      }
      setReload((value) => value + 1);
    } catch {
      setError('Kunne ikke oppheve signeringen.');
    } finally {
      setBusy(false);
    }
  }

  if ((!view || view.mode === 'off') && !planChangeOn && !cancellationOn) return null;

  const signing = view && view.mode !== 'off' ? view : null;
  const plan = signing?.plan || null;
  const shadow = signing?.shadow || null;
  const history = planChangeOn ? (lifecycle?.history || []) : (signing?.history || []);
  const conflicts = planChangeOn ? (lifecycle?.conflicts || []) : (signing?.conflicts || []);
  const choice = signing?.choice && signing.choice.alternatives.length === 2 ? signing.choice : null;
  return (
    <div className="md:col-span-2 rounded-lg border border-white/10 bg-[#161616] p-3 space-y-2 text-sm text-gray-200">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Plan</span>
        {signing?.mode === 'shadow' ? <span className="rounded bg-white/10 px-2 py-0.5 text-xs text-gray-300">Skygge</span> : null}
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
      {conflicts.length ? (
        <div className="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-amber-200 space-y-2">
          {conflicts.map((conflict) => (
            <div key={`${conflict.source}-${conflict.tierId}-${conflict.at}-${conflict.index ?? ''}`} className="flex flex-wrap items-center gap-2">
              <span>
                Avvik: {conflict.source} sier {conflict.tierName || conflict.tierId}{conflict.at ? ` (${shortDate(conflict.at)})` : ''}. Kontrakten gjelder til planen endres.
              </span>
              {planChangeOn && Number.isInteger(conflict.index) ? (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void resolveConflict(conflict.index as number, 'accept')}
                    className="px-3 py-1.5 rounded-lg bg-white/10 text-gray-100 text-xs hover:bg-white/15 disabled:opacity-50"
                  >
                    Godta
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void resolveConflict(conflict.index as number, 'dismiss')}
                    className="px-3 py-1.5 rounded-lg bg-white/10 text-gray-100 text-xs hover:bg-white/15 disabled:opacity-50"
                  >
                    Avvis
                  </button>
                </>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {signing?.siteConflicts && signing.siteConflicts.length ? (
        <div className="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-amber-200">
          Nettstedet som domenet eller koblingen peker på tilhører en annen kunde, så planen er ikke lagt på noe nettsted.
          Sjekk koblingen før kunden flyttes til utvikling.
        </div>
      ) : null}
      {signing && choice ? (
        <div className="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-amber-200 space-y-1">
          <div>
            {choice.contractReceived
              ? 'Kontrakten kom inn, men tilbudet har to alternativer. Velg det kunden signerte:'
              : 'Tilbudet har to alternativer. Når kunden har signert, marker kontrakten med alternativet kunden valgte:'}
          </div>
          <div className="flex flex-wrap gap-2">
            {choice.alternatives.map((alternative) => {
              const label = `Tilbud ${alternative.index + 1} (${alternative.tierName})`;
              return (
                <button
                  key={alternative.index}
                  type="button"
                  disabled={busy}
                  onClick={() => void signWithAlternative(alternative.index, label)}
                  className="px-3 py-1.5 rounded-lg bg-white/10 text-gray-100 text-xs hover:bg-white/15 disabled:opacity-50"
                >
                  {label}{priceLabel(alternative)}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      {shadow && signing?.mode === 'shadow' ? (
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
      {signing?.canConfirm ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void confirmServices()}
          className="px-3 py-1.5 rounded-lg bg-white/10 text-gray-100 text-xs hover:bg-white/15 disabled:opacity-50"
        >
          Bekreft tjenester
        </button>
      ) : null}
      {cancellationOn ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void unsign()}
          className="px-3 py-1.5 rounded-lg bg-white/10 text-gray-100 text-xs hover:bg-white/15 disabled:opacity-50"
        >
          Opphev signering
        </button>
      ) : null}
      {error ? <div className="text-xs text-red-400">{error}</div> : null}
      {history.length ? (
        <details className="text-xs text-gray-400">
          <summary className="cursor-pointer">Historikk</summary>
          <ul className="mt-1 space-y-0.5">
            {history.map((entry, index) => (
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
