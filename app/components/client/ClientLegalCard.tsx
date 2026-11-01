import React, { useEffect, useState } from 'react';
import { clientAuthHeaders } from '../../pages/client/auth';

type LegalState = {
  client: boolean;
  canSign?: boolean;
  current: { catalogVersion: number; dpaVersion: string; date: string };
  binding: {
    mode: 'catalog' | 'legacy' | 'unsigned';
    catalogVersion?: number;
    boundAt?: string;
    source?: 'signing' | 'notice';
    pendingNotice?: { catalogVersion: number; effectiveFrom: string } | null;
  };
  dpa: { status: string; required: boolean; missing: boolean; upToDate: boolean; version: string; offerVersion: string; signedAt: string; current: string };
  links: { vilkar: string; personvern: string; databehandleravtale: string; databehandleravtaleCurrent?: string };
};

function dateLabel(value = '') {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('nb-NO') : '';
}

/**
 * The client's terms version and data processing agreement, with a button to sign the current
 * DPA when the client's DPA is not the current version. Only the business's owner or an admin may
 * sign (canSign); other members are told so. A client who signed the service agreement
 * before the catalog has the DPA in force as published on the signing date, and is told so.
 * Renders nothing while the legal routes answer 404 (the legal switch is off) or on errors.
 */
export const ClientLegalCard: React.FC = () => {
  const [state, setState] = useState<LegalState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    fetch('/api/client/legal', { headers: clientAuthHeaders() })
      .then((response) => (response.status === 200 ? response.json() : null))
      .then((body) => {
        if (alive && body && body.binding) setState(body as LegalState);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!state || !state.client) return null;

  async function signDpa() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/client/dpa/sign', { method: 'POST', headers: clientAuthHeaders({ 'Content-Type': 'application/json' }), body: '{}' });
      const body = await response.json().catch(() => null);
      if (response.status !== 200 || !body?.binding) throw new Error(body?.message || 'Kunne ikke signere.');
      setState(body as LegalState);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke signere.');
    } finally {
      setBusy(false);
    }
  }

  const { binding, dpa, links, current } = state;
  const boundLabel = binding.source === 'notice' ? 'gjelder fra' : 'signert';
  const pending = binding.pendingNotice
    ? ` Versjon ${binding.pendingNotice.catalogVersion} gjelder fra ${dateLabel(binding.pendingNotice.effectiveFrom)}.`
    : '';
  const terms = (binding.mode === 'catalog'
    ? `Versjon ${binding.catalogVersion}${binding.boundAt ? `, ${boundLabel} ${dateLabel(binding.boundAt)}` : ''}`
    : binding.mode === 'legacy'
      ? 'Vilkårene som gjaldt da du signerte'
      : `Versjon ${current.catalogVersion} gjelder når du signerer`) + pending;
  const dpaLine = dpa.status === 'signed'
    ? `Signert ${dateLabel(dpa.signedAt)} (versjon ${dpa.version})`
    : dpa.status === 'accepted-with-contract'
      ? `Godtatt med tjenesteavtalen (versjon ${dpa.offerVersion || dpa.current})`
      : dpa.status === 'outdated'
        ? `Versjon ${dpa.version || dpa.offerVersion} gjelder for deg. Du kan signere gjeldende versjon (${dpa.current}).`
        : dpa.status === 'accepted-legacy'
          ? `Godtatt med tjenesteavtalen, i versjonen som gjaldt da du signerte. Du kan signere gjeldende versjon (${dpa.current}).`
          : dpa.missing
            ? 'Ikke signert. E-postfunksjonene på nettsiden er av til databehandleravtalen er signert.'
            : 'Gjelder fra du signerer tjenesteavtalen.';
  const signable = dpa.missing || (dpa.required && !dpa.upToDate);
  const allowed = state.canSign !== false;

  return (
    <section className="rounded-2xl border border-[#E5E7EB] bg-white p-5">
      <h2 className="text-lg font-semibold text-[#111827]">Vilkår og databehandleravtale</h2>
      <div className="mt-3 space-y-2 text-sm">
        <p>
          <span className="text-[#6B7280]">Vilkår:</span> {terms}{' '}
          <a href={links.vilkar} className="text-[#FF5B00] hover:underline">Les vilkårene</a>
        </p>
        <p>
          <span className="text-[#6B7280]">Databehandleravtale:</span> {dpaLine}{' '}
          <a href={links.databehandleravtale} className="text-[#FF5B00] hover:underline">Les avtalen</a>
        </p>
      </div>
      {signable && !allowed ? (
        <p className="mt-3 text-sm text-[#6B7280]">Bare eieren eller en administrator i bedriften kan signere databehandleravtalen.</p>
      ) : null}
      {signable && allowed ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => void signDpa()} disabled={busy} className="rounded-lg bg-[#FF5B00] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {busy ? 'Signerer...' : dpa.missing ? 'Signer databehandleravtale' : `Signer versjon ${dpa.current}`}
          </button>
          {links.databehandleravtaleCurrent && links.databehandleravtaleCurrent !== links.databehandleravtale ? (
            <a href={links.databehandleravtaleCurrent} className="text-sm text-[#FF5B00] hover:underline">Les gjeldende versjon</a>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
    </section>
  );
};
